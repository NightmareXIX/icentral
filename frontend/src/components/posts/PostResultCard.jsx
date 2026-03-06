import { useNavigate } from 'react-router-dom';
import { getPostAuthorDisplayName } from '../../utils/postAuthor';

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

export default function PostResultCard({ post, index = 0 }) {
  const navigate = useNavigate();

  function openPost() {
    if (!post?.id) return;
    navigate(`/posts/${post.id}`);
  }

  function handleCardKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPost();
  }

  const imageUrl = getPostImageUrl(post);
  const authorLabel = getPostAuthorDisplayName(post, 'Community member');

  return (
    <article
      className="feed-card social-post-card feed-card-linkable search-result-card"
      style={{ '--card-index': index }}
      role="link"
      tabIndex={0}
      onClick={openPost}
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

        <div className="pill-row">
          <span className={`pill tone-${statusTone(post?.status)}`}>{post?.status || 'unknown'}</span>
          {post?.pinned && <span className="pill tone-pin">Pinned</span>}
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
        <span className="pill" title={authorLabel}>{authorLabel}</span>
      </div>
    </article>
  );
}
