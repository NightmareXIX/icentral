function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function getPostAuthorDisplayName(post, fallback = 'Unknown user') {
  const authorName = normalizeText(post?.authorName) || normalizeText(post?.author_name);
  if (authorName) return authorName;

  const profile = post?.author || {};
  const profileName = normalizeText(profile.fullName)
    || normalizeText(profile.full_name)
    || normalizeText(profile.name);
  if (profileName) return profileName;

  const username = normalizeText(profile.username);
  if (username) return username;

  return fallback;
}
