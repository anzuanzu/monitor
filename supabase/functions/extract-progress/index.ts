// 部署前：supabase secrets set GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.5-flash-lite
// 此 function 只接受已登入且具有 manager 權限的使用者；Gemini key 不會出現在前端。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type ImportTarget = { mode?: string; key?: string; label?: string };

const buildPrompt = (knownSalespeople: Array<{ name?: string; jobTitle?: string }> = [], importTarget: ImportTarget = {}) => {
  const isTargetedImport = importTarget.mode === 'standard' || importTarget.mode === 'custom';
  const targetLabel = String(importTarget.label || importTarget.key || '').trim();
  const targetInstruction = isTargetedImport
    ? `本次管理者指定只帶入「${targetLabel}」。每位人員請從檔案中取出對應該指標的值，填入 importValue；不要猜測或填入其他指標。若找不到該人員的值，importValue 填空字串。`
    : '本次未指定目標指標，請依欄位意義完整萃取所有實際出現的預設與自訂指標。';
  return `請從提供的業務績效圖片或檔案萃取紀錄。先判斷檔案包含一位或多位業務人員，以及每個人實際提供了哪些指標；只回傳符合下列結構的 JSON，不要 markdown，也不要編造資料。
{
  "detectedMetrics": ["檔案中辨識到的所有績效欄位名稱"],
  "records": [{
    "salespersonName": "完整姓名或空字串",
    "jobTitle": "文字或空字串",
    "importValue": "只有指定帶入目標指標時才填入該人員的值；否則填空字串",
    "validCalls": "有效電訪數字；欄位不存在時填 null",
    "validMeetings": "有效面訪數字；欄位不存在時填 null",
    "abayProgress": "亞灣完整文字紀錄；不存在時填空字串",
    "svipUpgradeProgress": "SVIP 升等完整文字紀錄；不存在時填空字串",
    "vipUpgradeProgress": "VIP 升等完整文字紀錄；不存在時填空字串",
    "hvipProgress": "HVIP 完整文字紀錄；不存在時填空字串",
    "callProgress": "電訪完整文字紀錄；不存在時填空字串",
    "coverageRate": "覆蓋率，例如 44%；不存在時填空字串",
    "customMetrics": { "其他欄位名稱": "該人員的完整文字、數字或狀態紀錄" }
  }]
}
請先逐欄讀取表頭，再逐列讀取人員；detectedMetrics 必須列出姓名／職級以外的全部績效欄位。每一列人員都要建立一個 records 項目，不可只回傳第一人，也不可因部分欄位空白而漏掉其他人。同一人在檔案中出現多列時，請合併成一筆完整 records。
已定義的欄位請放進對應欄位；任何未定義的新欄位都必須使用原始表頭名稱加入 customMetrics，讓系統自動建立欄位。所有「進度」保留為可讀的完整文字，不要轉成百分比；覆蓋率保留百分比。若圖片是多人表格，records 必須包含表格內每一位人員及其各欄數值。
${targetInstruction}
已建立的業務人員名單如下：${JSON.stringify(knownSalespeople.map(person => ({ name: String(person.name || '').trim(), jobTitle: String(person.jobTitle || '').trim() })).filter(person => person.name))}
從圖片或檔案辨識到業務人員時，請優先比對上述名單，並在 salespersonName 回傳名單中的完整姓名；若沒有可信的相符人員，才回傳空字串。`;
};

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authorization = request.headers.get('Authorization') || '';
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error('未登入');
    const { data: profile, error: profileError } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (profileError || profile?.role !== 'manager') return Response.json({ error: '僅管理者可使用 AI 匯入。' }, { status: 403, headers: corsHeaders });

    const { mimeType, contentBase64, knownSalespeople = [], importTarget = {} } = await request.json();
    if (!contentBase64 || !mimeType) throw new Error('缺少檔案內容');
    if (contentBase64.length > 12_000_000) throw new Error('檔案過大，請縮小至 8MB 以下。');
    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiKey) throw new Error('尚未設定 Gemini API 金鑰。');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: buildPrompt(Array.isArray(knownSalespeople) ? knownSalespeople.slice(0, 300) : [], importTarget && typeof importTarget === 'object' ? importTarget : {}) }, { inline_data: { mime_type: mimeType, data: contentBase64 } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1, candidateCount: 1 } })
    });
    if (!response.ok) throw new Error(`Gemini 回應失敗：${await response.text()}`);
    const result = await response.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini 未回傳可讀取內容');
    const parsed = JSON.parse(text);
    const record = Array.isArray(parsed) ? { records: parsed } : parsed;
    if (!Array.isArray(record?.records)) throw new Error('Gemini 回傳格式不完整，請重新辨識。');
    return Response.json({ record }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return Response.json({ error: error.message || '辨識失敗' }, { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
