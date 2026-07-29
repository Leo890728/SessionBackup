export function selectFetchedRemoteBranch(
  refs: string[],
  preferredBranch: string
): string | undefined {
  const branches = refs
    .map((ref) => ref.trim().replace(/^origin\//, ""))
    .filter((ref) => ref && ref !== "HEAD");
  if (branches.includes(preferredBranch)) {
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
