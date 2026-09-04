export function looksLikeHtmlErrorPage(text: string): boolean {
  const s = text.trimStart();
  if (/^<!DOCTYPE html/i.test(s) || /^<html[\s>]/i.test(s)) return true;
  if (/<html[\s>]/i.test(s) && /<head[\s>]/i.test(s)) return true;
  if (/<style[\s>]/i.test(s) && /<\/(?:html|body|head)>/i.test(s)) return true;
  return false;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(html: string, tag: string): string {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? stripTags(m[1]) : "";
}

function extractClassText(html: string, className: string): string {
  const m = html.match(
    new RegExp(`<[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</`, "i"),
  );
  return m ? stripTags(m[1]) : "";
}

function isUsefulSnippet(text: string): boolean {
  if (!text) return false;
  if (text.length > 120) return false;
  if (/[<>{}]|font-family|@keyframes|viewBox/i.test(text)) return false;
  return /[A-Za-z\u4e00-\u9fff]/.test(text);
}

/** Provider failures sometimes embed a full HTML WAF/blocked page as the payload. */
export function sanitizeProviderErrorMessage(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  if (!looksLikeHtmlErrorPage(text)) {
    if (text.length > 4000) return `${text.slice(0, 4000)}\n…(truncated)`;
    return text;
  }

  const snippets = [
    extractTag(text, "title"),
    extractClassText(text, "message"),
    extractClassText(text, "explanation"),
  ].filter(isUsefulSnippet);
  const unique = [...new Set(snippets)];
  const reason = unique[0];
  if (reason) {
    return `模型调用失败：${reason}。供应商返回了错误网页，而不是接口结果。`;
  }
  return "模型调用失败：供应商返回了错误网页，而不是接口结果。请检查模型通道、API Key，或稍后重试。";
}
