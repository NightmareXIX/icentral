import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/useAuth';
import { openUserProfile } from '../../utils/profileNavigation';
import {
  getCollabOpeningsLeft,
  getCollabPendingRequestCount,
  getCollabRequestForUser,
  REQUEST_STATUS,
} from '../../utils/collabApi';

const CARD_NAV_IGNORE_SELECTOR = 'a,button,input,textarea,select,label,[role="button"],[data-prevent-card-nav="true"]';

function formatDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function normalizeRequestStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === REQUEST_STATUS.ACCEPTED) return REQUEST_STATUS.ACCEPTED;
  if (normalized === REQUEST_STATUS.REJECTED) return REQUEST_STATUS.REJECTED;
  return REQUEST_STATUS.PENDING;
}

function getRequestBadgeText(status) {
  if (status === REQUEST_STATUS.ACCEPTED) return 'Request accepted';
  if (status === REQUEST_STATUS.REJECTED) return 'Request rejected';
  return 'Request pending';
}

function stopPropagation(event) {
  event.stopPropagation();
}

export default function CollabPostCard({ post, index = 0 }) {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const currentUserId = String(user?.id || '').trim();

  const creatorId = String(post?.creator?.id || '').trim();
  const creatorName = String(post?.creator?.name || 'Community member');
  const creatorRole = String(post?.creator?.role || 'Member');
  const openingsLeft = getCollabOpeningsLeft(post);
  const pendingRequestCount = getCollabPendingRequestCount(post);
  const request = getCollabRequestForUser(post, currentUserId);
  const requestStatus = request ? normalizeRequestStatus(request.status) : null;
  const isOpen = String(post?.status || '').toUpperCase() === 'OPEN';
  const isOwner = creatorId && currentUserId && creatorId === currentUserId;
  const showFacultyLedTag = creatorRole === 'Faculty' || creatorRole === 'Admin';
  const canRequest = isAuthenticated && !isOwner && isOpen
    && requestStatus !== REQUEST_STATUS.PENDING
    && requestStatus !== REQUEST_STATUS.ACCEPTED;

  function shouldIgnoreCardNavigation(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(CARD_NAV_IGNORE_SELECTOR));
  }

  function openDetails() {
    if (!post?.id) return;
    navigate(`/collaborate/${encodeURIComponent(post.id)}`);
  }

  function handleCardClick(event) {
    if (shouldIgnoreCardNavigation(event.target)) return;
    openDetails();
  }

  function handleCardKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (shouldIgnoreCardNavigation(event.target)) return;
    event.preventDefault();
    openDetails();
  }

  function handleOpenProfile(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!creatorId) return;
    openUserProfile(navigate, creatorId, currentUserId);
  }

  return (
    <article
      className="feed-card social-post-card collab-post-card feed-card-linkable"
      style={{ '--card-index': index }}
      role="link"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
    >
      <div className="social-post-header">
        <div className="post-author-chip">
          <span className="post-avatar">C</span>
          <div>
            <strong>{post?.title || 'Collaboration opportunity'}</strong>
            <small>Posted {formatDate(post?.createdAt)}</small>
          </div>
        </div>

        <div className="pill-row">
          <span className="pill collab-category-pill">{post?.category || 'Collaboration'}</span>
          <span className={`pill ${isOpen ? 'tone-ok' : 'tone-muted'}`}>{isOpen ? 'OPEN' : 'CLOSED'}</span>
        </div>
      </div>

      <p className="feed-summary">{post?.summary || 'No summary provided.'}</p>

      {Array.isArray(post?.requiredSkills) && post.requiredSkills.length > 0 && (
        <ul className="mini-tag-row" aria-label="Required skills">
          {post.requiredSkills.slice(0, 8).map((skill) => (
            <li key={`${post.id}-${skill}`}>
              <span className="mini-tag">{skill}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="collab-meta-grid">
        <span className="pill">Time: {post?.timeCommitmentHoursPerWeek || 0}h/week</span>
        <span className="pill">Mode: {post?.mode || 'HYBRID'}</span>
        <span className="pill">Duration: {post?.duration || 'Not specified'}</span>
        <span className="pill">Openings: {openingsLeft}/{post?.openings || 1}</span>
      </div>

      <div className="post-utility-bar">
        {creatorId ? (
          <button
            type="button"
            className="pill author-nav-pill"
            title={`${creatorName} (${creatorRole})`}
            onClick={handleOpenProfile}
          >
            {creatorName}
          </button>
        ) : (
          <span className="pill">{creatorName}</span>
        )}
        <span className="pill">{creatorRole}</span>
        {showFacultyLedTag && <span className="pill tone-ok">Faculty-led</span>}
        <span className="pill">{pendingRequestCount} pending request(s)</span>
      </div>

      <div className="feed-card-actions collab-card-actions">
        <Link
          className="btn btn-soft"
          to={`/collaborate/${encodeURIComponent(post?.id || '')}`}
          onClick={stopPropagation}
        >
          View Details
        </Link>

        {canRequest ? (
          <Link
            className="btn btn-primary-solid"
            to={`/collaborate/${encodeURIComponent(post?.id || '')}`}
            state={{ openJoinComposer: true }}
            onClick={stopPropagation}
          >
            Request to Join
          </Link>
        ) : requestStatus ? (
          <span className={`pill collab-request-pill is-${requestStatus.toLowerCase()}`}>
            {getRequestBadgeText(requestStatus)}
          </span>
        ) : null}
      </div>
    </article>
  );
}
