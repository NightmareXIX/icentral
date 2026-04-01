import { apiRequest } from './profileApi';

export function toTitleCase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export function getPostOwnerId(post) {
  return String(
    post?.author?.id
    || post?.authorId
    || post?.author_id
    || post?.creator?.id
    || '',
  ).trim();
}

export function isPostOwner(post, user) {
  const ownerId = getPostOwnerId(post);
  const currentUserId = String(user?.id || '').trim();
  return Boolean(ownerId && currentUserId && ownerId === currentUserId);
}

export function canManagePost(post, user, isModerator = false) {
  return Boolean(isModerator || isPostOwner(post, user));
}

export function getPostManagementStatus(post) {
  const postStatus = String(post?.postStatus || post?.post_status || '').trim().toLowerCase();
  if (postStatus) return postStatus;
  return String(post?.status || '').trim().toLowerCase();
}

export function isPostArchived(post) {
  return getPostManagementStatus(post) === 'archived';
}

export function getPostLabel(post, fallback = 'post') {
  const title = String(post?.title || '').trim();
  if (title) return title;

  const category = String(post?.category || '').trim();
  if (category) return category;

  const type = String(post?.type || fallback).trim();
  return `${toTitleCase(type)} post`;
}

export async function archivePostById(postId) {
  const result = await apiRequest(`/posts/posts/${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ archive: true }),
  });
  return result?.data || null;
}

export async function deletePostById(postId) {
  const result = await apiRequest(`/posts/posts/${encodeURIComponent(postId)}`, {
    method: 'DELETE',
  });
  return result?.data || null;
}
