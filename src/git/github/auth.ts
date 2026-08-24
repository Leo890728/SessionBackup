/** GitHub 授權：向 VS Code 取 session token，與 git over HTTPS 的認證 header。 */

import * as vscode from "vscode";

export async function getSessionToken(
  createIfNone: boolean,
  scopes: readonly string[] = ["repo"]
): Promise<string | undefined> {
  try {
    const s = await vscode.authentication.getSession(
      "github",
      [...scopes],
      createIfNone ? { createIfNone: true } : { silent: true }
    );
    return s?.accessToken;
  } catch {
    return undefined;
  }
}

/** git over HTTPS 用的認證 header（token 不會寫進 .git/config）。 */
export function tokenHeader(token: string): string {
  return (
    "AUTHORIZATION: basic " +
    Buffer.from("x-access-token:" + token, "utf8").toString("base64")
  );
}
