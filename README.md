# 軌跡｜業務績效監控儀表板

跨裝置的業務軌跡與績效監控工具。資料存於 Supabase；所有使用者都必須登入，只有 `manager` 可新增、編輯、刪除資料。

## 功能

- 依日期、業務人員與項目繪製績效圖表
- 每日追蹤：有效電訪、有效面訪、亞灣、SVIP／VIP／HVIP、電訪進度、覆蓋率
- 自訂任意專案名稱與進度
- 管理者可由 CSV、XLSX、TXT 帶入表單；圖片或文字檔可選用 Gemini 萃取欄位
- 角色權限：`viewer` 只看資料，`manager` 才能輸入與管理

## 第一次雲端設定

### 1. 建立 Supabase 專案

在 Supabase 建立新專案後，到 **SQL Editor** 貼上並執行 [`supabase/schema.sql`](supabase/schema.sql)。這會建立資料表、登入後預設 viewer 的 profile、以及 Row Level Security 權限。

在 **Authentication → Providers → Email** 開啟 Email 登入。建議關閉公開註冊（Enable signups），由管理者在 Supabase 的 **Authentication → Users** 邀請或建立帳號。

### 2. 指定管理者

先在 Supabase Authentication 建立你的使用者帳號，然後在 SQL Editor 執行（更換 email）：

```sql
update public.profiles
set role = 'manager'
where id = (select id from auth.users where email = 'YOUR_EMAIL@example.com');
```

其他帳號預設為 `viewer`。需要管理權限時，將 role 改為 `manager` 即可。

### 3. 連接前端

到 **Project Settings → API** 複製 Project URL 與 anon public key，填入 [`config.js`](config.js)：

```js
window.MONITOR_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR_ANON_PUBLIC_KEY'
};
```

`anon public key` 可以放在前端；真正的資料保護由 schema 中的 RLS 規則執行。**不要**將 `service_role` key 放入 GitHub 或 `config.js`。

### 4. 選用：啟用 Gemini 辨識

Gemini 金鑰必須只存於 Supabase Edge Function 的 secret。先安裝並登入 [Supabase CLI](https://supabase.com/docs/guides/cli)，然後在本專案執行：

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy extract-progress
supabase secrets set GEMINI_API_KEY=YOUR_GEMINI_API_KEY GEMINI_MODEL=gemini-2.0-flash
```

Edge Function 程式在 [`supabase/functions/extract-progress/index.ts`](supabase/functions/extract-progress/index.ts)。它會再次檢查登入者是否為 `manager`，所以檢視者無法呼叫 Gemini。

使用「Gemini 辨識」時，系統會在送出前顯示確認；確認後檔案內容才會傳送給 Google Gemini。含有客戶個資、帳號、身分證字號或其他敏感資料的檔案，請先遮蔽後再使用。

## 發布

這是純靜態網站，可直接用 GitHub Pages：

1. 將已填寫 Supabase URL 與 anon key 的 `config.js` 提交到 `main`。
2. GitHub 專案 Settings → Pages → Deploy from a branch → `main` / `/ (root)`。
3. 登入頁面即可跨裝置讀寫同一份 Supabase 資料。

## 備份

Supabase 可以從 Dashboard 匯出資料表 CSV；建議定期匯出 `salespeople` 與 `performance_entries`。程式碼與每次介面修改則由 Git commit 完整保留。
