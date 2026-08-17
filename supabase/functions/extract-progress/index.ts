// 部署前：supabase secrets set GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.5-flash-lite
// 此 function 只接受已登入且具有 manager 權限的使用者；Gemini key 不會出現在前端。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const prompt = `請從提供的業務績效圖片或檔案萃取「單一筆」紀錄。只回傳符合下列結構的 JSON，不要 markdown，也不要編造資料。
{
  "viewDate": "YYYY-MM-DD 或空字串",
  "salespersonName": "文字或空字串",
  "jobTitle": "文字或空字串",
  "validCalls": "有效電訪數字；找不到填 0",
  "validMeetings": "有效面訪數字；找不到填 0",
  "abayProgress": "完整文字紀錄或空字串",
  "svipUpgradeProgress": "完整文字紀錄或空字串",
  "vipUpgradeProgress": "完整文字紀錄或空字串",
  "hvipProgress": "完整文字紀錄或空字串",
  "callProgress": "完整文字紀錄或空字串",
  "coverageRate": "完整文字紀錄或空字串",
  "customMetrics": { "圖片／檔案中其他未列出的指標名稱": "其完整文字、數字或狀態紀錄" }
}
所有「進度」都必須保留為可讀的文字紀錄，不要轉成百分比。customMetrics 只保留實際出現的額外指標；找不到時回傳空物件。`;

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authorization = request.headers.get('Authorization') || '';
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error('未登入');
    const { data: profile, error: profileError } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (profileError || profile?.role !== 'manager') return Response.json({ error: '僅管理者可使用 AI 匯入。' }, { status: 403, headers: corsHeaders });

    const { mimeType, contentBase64 } = await request.json();
    if (!contentBase64 || !mimeType) throw new Error('缺少檔案內容');
    if (contentBase64.length > 12_000_000) throw new Error('檔案過大，請縮小至 8MB 以下。');
    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiKey) throw new Error('尚未設定 Gemini API 金鑰。');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: contentBase64 } }] }], generationConfig: { responseMimeType: 'application/json' } })
    });
    if (!response.ok) throw new Error(`Gemini 回應失敗：${await response.text()}`);
    const result = await response.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini 未回傳可讀取內容');
    return Response.json({ record: JSON.parse(text) }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return Response.json({ error: error.message || '辨識失敗' }, { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
