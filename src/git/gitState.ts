export function selectFetchedRemoteBranch(
  refs: string[],
  preferredBranch: string | undefined
): string | undefined {
  const branches = refs
    .map((ref) => ref.trim().replace(/^origin\//, ""))
    .filter((ref) => ref && ref !== "HEAD");
  if (preferredBranch && branches.includes(preferredBranch)) {
    return preferredBranch;
  }
  if (branches.includes("main")) {
    return "main";
  }
  if (branches.includes("master")) {
    return "master";
  }
  return branches[0];
}
