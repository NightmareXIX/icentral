import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/useAuth';
import PostActionsMenu from './PostActionsMenu';
import { getPostAuthorDisplayName } from '../../utils/postAuthor';
import {
  archivePostById,
  canManagePost,
  deletePostById,
  getPostLabel,
  isPostArchived,
} from '../../utils/postManagement';
import { openUserProfile } from '../../utils/profileNavigation';

const CARD_NAV_IGNORE_SELECTOR = 'a,button,input,textarea,select,label,[role="button"],[data-prevent-card-nav="true"]';

function formatDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function statusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'published') return 'ok';
  if (normalized === 'archived') return 'muted';
  if (normalized === 'draft') return 'warn';
  return 'neutral';
}

function getPostImageUrl(post) {
  if (!Array.isArray(post?.refs)) return '';
  const imageRef = post.refs.find((ref) => (
    ref?.service === 'image-upload'
    && typeof ref?.metadata?.imageDataUrl === 'string'
    && ref.metadata.imageDataUrl.trim()
  ));
  return imageRef?.metadata?.imageDataUrl?.trim() || '';
}

export default function PostResultCard({
  post,
  index = 0,
  onPostUpdated,
  onPostDeleted,
  onActionFeedback,
}) {
  const navigate = useNavigate();
  const { isAuthenticated, isModerator, user } = useAuth();
  const [busyAction, setBusyAction] = useState(false);
  const currentUserId = String(user?.id || '').trim();
  const canManage = canManagePost(post, user, isModerator);
  const archived = isPostArchived(post);

  function openPost() {
    if (!post?.id) return;
    navigate(`/posts/${post.id}`);
  }

  function shouldIgnoreCardNavigation(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(CARD_NAV_IGNORE_SELECTOR));
  }

  function handleCardKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (shouldIgnoreCardNavigation(event.target)) return;
    event.preventDefault();
    openPost();
  }

  const imageUrl = getPostImageUrl(post);
  const authorLabel = getPostAuthorDisplayName(post, 'Community member');
  const authorId = post?.author?.id || post?.authorId || null;

  function handleOpenAuthorProfile(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!authorId) return;
    openUserProfile(navigate, authorId, currentUserId);
  }

  async function handleArchivePost() {
    if (!post?.id) return;
    if (!isAuthenticated) {
      onActionFeedback?.({ type: 'error', message: 'Sign in to update posts.' });
      return;
    }

    setBusyAction(true);
    try {
      await archivePostById(post.id);
      onPostUpdated?.(post.id, { status: 'archived', postStatus: 'archived' });
      onActionFeedback?.({ type: 'success', message: 'Post archived.' });
    } catch (error) {
      onActionFeedback?.({ type: 'error', message: `Post update failed: ${error.message}` });
    } finally {
      setBusyAction(false);
    }
  }

  async function handleDeletePost() {
    if (!post?.id) return;
    if (!isAuthenticated) {
      onActionFeedback?.({ type: 'error', message: 'Sign in to delete posts.' });
      return;
    }

    const confirmed = window.confirm(`Delete "${getPostLabel(post)}" permanently?`);
    if (!confirmed) return;

    setBusyAction(true);
    try {
      await deletePostById(post.id);
      onPostDeleted?.(post.id);
      onActionFeedback?.({ type: 'success', message: 'Post deleted.' });
    } catch (error) {
      onActionFeedback?.({ type: 'error', message: `Post delete failed: ${error.message}` });
    } finally {
      setBusyAction(false);
    }
  }

  return (
    <article
      className="feed-card social-post-card feed-card-linkable search-result-card"
      style={{ '--card-index': index }}
      role="link"
      tabIndex={0}
      onClick={(event) => {
        if (shouldIgnoreCardNavigation(event.target)) return;
        openPost();
      }}
      onKeyDown={handleCardKeyDown}
    >
      <div className="social-post-header">
        <div className="post-author-chip">
          <span className="post-avatar">{(post?.type || 'P').slice(0, 1)}</span>
          <div>
            <strong>{post?.title || `${post?.type || 'Post'} update`}</strong>
            <small>{formatDate(post?.createdAt)}</small>
          </div>
        </div>

        <div className="post-card-header-tools">
          <div className="pill-row">
            <span className={`pill tone-${statusTone(post?.status)}`}>{post?.status || 'unknown'}</span>
            {post?.pinned && <span className="pill tone-pin">Pinned</span>}
          </div>

          {canManage && (
            <PostActionsMenu
              buttonLabel={`Open actions for ${getPostLabel(post)}`}
              menuLabel={`Post actions for ${getPostLabel(post)}`}
              actions={[
                {
                  key: 'archive',
                  label: 'Archive',
                  disabled: busyAction || archived,
                  onSelect: handleArchivePost,
                },
                {
                  key: 'delete',
                  label: 'Delete',
                  tone: 'danger',
                  disabled: busyAction,
                  onSelect: handleDeletePost,
                },
              ]}
            />
          )}
        </div>
      </div>

      {imageUrl && (
        <div className="feed-image-wrap">
          <img src={imageUrl} alt={post?.title || 'Post image'} loading="lazy" />
        </div>
      )}

      <p className="feed-summary">{post?.summary || 'No summary provided.'}</p>

      {Array.isArray(post?.tags) && post.tags.length > 0 && (
        <ul className="mini-tag-row" aria-label="Post tags">
          {post.tags.slice(0, 6).map((tag) => (
            <li key={`${post.id}-${tag.id || tag.slug || tag.name}`}>
              <span className="mini-tag">#{tag.name || tag.slug || 'tag'}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="post-utility-bar">
        <span className="pill">{post?.type || 'POST'}</span>
        {post?.expiresAt && <span className="pill">Expires {formatDate(post.expiresAt)}</span>}
        {authorId ? (
          <button type="button" className="pill author-nav-pill" title={authorLabel} onClick={handleOpenAuthorProfile}>
            {authorLabel}
          </button>
        ) : (
          <span className="pill" title={authorLabel}>{authorLabel}</span>
        )}
      </div>
    </article>
  );
}
