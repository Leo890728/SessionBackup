/**
 * HTML 逸出的單一來源。
 *
 * 這是所有 webview 輸出的安全邊界：對話內容、檔名、語法上色的 token
 * 都必須先經過這裡，才不會把標籤注入 webview。
 *
 * 刻意不相依任何模組——markdownHtml 與 highlight 互相需要對方的能力，
 * 逸出規則放在葉節點才不會讓兩者形成循環。
 */

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char
  );
}
