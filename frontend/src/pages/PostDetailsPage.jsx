import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { getJobDetailsFromPost } from '../utils/jobPortalStorage';
import { openUserProfile } from '../utils/profileNavigation';
import EventMetadataBlock from '../components/posts/EventMetadataBlock';
import VolunteerEnrollmentModal from '../components/posts/VolunteerEnrollmentModal';
import {
  buildVolunteerEnrollmentInitialValues,
  isEventOver,
  isEventPostType,
  isVolunteerEligibleEvent,
} from '../utils/eventPost';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
const COMMENT_PAGE_LIMIT = 200;
const compactCountFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

async function apiRequest(path, options = {}) {
  const storedToken = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(storedToken ? { Authorization: `Bearer ${storedToken}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof data === 'string'
      ? data
      : data?.error || data?.message || 'Request failed';
    throw new Error(message);
  }

  return data;
}

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

function formatRelativeTime(value) {
  if (!value) return 'No timestamp';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No timestamp';

  const diffMs = Date.now() - date.getTime();
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < minuteMs) return 'Just now';
  if (diffMs < hourMs) return `${Math.max(1, Math.floor(diffMs / minuteMs))}m ago`;
  if (diffMs < dayMs) return `${Math.max(1, Math.floor(diffMs / hourMs))}h ago`;
  if (diffMs < 7 * dayMs) return `${Math.max(1, Math.floor(diffMs / dayMs))}d ago`;

  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function toTitleCase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function getBaseVoteScore(post) {
  const value = Number(
    post?.score
    ?? post?.voteScore
    ?? post?.upvotes
    ?? post?.upvoteCount
    ?? post?.votes,
  );
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function getCommentCount(post) {
  if (Array.isArray(post?.comments)) return post.comments.length;
  const value = Number(
    post?.commentCount
    ?? post?.commentsCount
    ?? post?.totalComments,
  );
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function formatCompactCount(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '0';
  return compactCountFormatter.format(Math.trunc(numericValue));
}

function getDisplayName(entity) {
  return entity?.fullName
    || entity?.full_name
    || entity?.name
    || entity?.username
    || entity?.email
    || '';
}

function getPostAuthorLabel(post, currentUser = null) {
  const resolved = getDisplayName(post?.author)
    || post?.authorName
    || post?.author_name;
  if (resolved) return String(resolved);
  if (post?.authorId && currentUser?.id && String(post.authorId) === String(currentUser.id)) {
    const ownName = getDisplayName(currentUser);
    if (ownName) return String(ownName);
  }
  if (post?.authorId) return `User ${String(post.authorId).slice(0, 8)}`;
  return 'Community member';
}

function getCommentAuthorLabel(comment, currentUser = null) {
  const resolved = getDisplayName(comment?.author)
    || comment?.authorName
    || comment?.author_name;
  if (resolved) return String(resolved);
  if (comment?.authorId && currentUser?.id && String(comment.authorId) === String(currentUser.id)) {
    const ownName = getDisplayName(currentUser);
    if (ownName) return String(ownName);
  }
  if (comment?.authorId) return `User ${String(comment.authorId).slice(0, 8)}`;
  return 'Community member';
}

export default function PostDetailsPage() {
  const { postId } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, user } = useAuth();
  const currentUserId = String(user?.id || '').trim();

  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [loadingPost, setLoadingPost] = useState(true);
  const [loadingComments, setLoadingComments] = useState(true);
  const [pageError, setPageError] = useState('');
  const [banner, setBanner] = useState({ type: 'idle', message: '' });
  const [actionBusy, setActionBusy] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [sharingLink, setSharingLink] = useState(false);
  const [volunteerBusy, setVolunteerBusy] = useState(false);
  const [volunteerModalOpen, setVolunteerModalOpen] = useState(false);
  const [volunteers, setVolunteers] = useState([]);
  const [loadingVolunteers, setLoadingVolunteers] = useState(false);

  const normalizedRole = String(user?.role || '').toLowerCase();
  const isJobPost = String(post?.type || '').toUpperCase() === 'JOB';
  const isCollabPost = String(post?.type || '').toUpperCase() === 'COLLAB';
  const isEventPost = isEventPostType(post?.type);
  const isVolunteerEvent = isVolunteerEligibleEvent(post);
  const jobDetails = isJobPost ? getJobDetailsFromPost(post) : null;
  const isOwner = post?.authorId && user?.id && String(post.authorId) === String(user.id);
  const canViewApplications = isJobPost && isOwner && normalizedRole === 'alumni';

  const imageRef = useMemo(() => {
    if (!Array.isArray(post?.refs)) return null;
    return post.refs.find((ref) => ref?.service === 'image-upload' && ref?.metadata?.imageDataUrl) || null;
  }, [post]);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function loadPostAndComments() {
      if (!postId) {
        setLoadingPost(false);
        setLoadingComments(false);
        setPageError('Missing post id.');
        return;
      }

      setLoadingPost(true);
      setLoadingComments(true);
      setPageError('');

      try {
        const postResult = await apiRequest(`/posts/posts/${postId}`, {
          signal: controller.signal,
        });
        if (!isMounted) return;

        const loadedPost = postResult?.data || null;
        if (!loadedPost) {
          setPageError('Post not found.');
          setPost(null);
          setComments([]);
          return;
        }

        setPost(loadedPost);

        try {
          const commentsResult = await apiRequest(`/posts/posts/${postId}/comments?limit=${COMMENT_PAGE_LIMIT}&offset=0`, {
            signal: controller.signal,
          });
          if (!isMounted) return;
          const list = Array.isArray(commentsResult?.data) ? commentsResult.data : [];
          const total = Number(commentsResult?.pagination?.total);
          setComments(list);
          if (Number.isFinite(total)) {
            setPost((prev) => (prev ? {
              ...prev,
              commentCount: Math.max(0, Math.trunc(total)),
              commentsCount: Math.max(0, Math.trunc(total)),
            } : prev));
          }
        } catch (error) {
          if (!isMounted || error.name === 'AbortError') return;
          setComments([]);
          setBanner({ type: 'error', message: `Could not load comments: ${error.message}` });
        }
      } catch (error) {
        if (!isMounted || error.name === 'AbortError') return;
        setPageError(error.message || 'Could not load post details.');
      } finally {
        if (isMounted) {
          setLoadingPost(false);
          setLoadingComments(false);
        }
      }
    }

    loadPostAndComments();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [postId]);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function loadVolunteerRoster() {
      if (!post?.id || !isVolunteerEvent || !isOwner) {
        setVolunteers([]);
        setLoadingVolunteers(false);
        return;
      }

      setLoadingVolunteers(true);
      try {
        const result = await apiRequest(`/posts/posts/${post.id}/volunteers`, {
          signal: controller.signal,
        });
        if (!isMounted) return;
        setVolunteers(Array.isArray(result?.data) ? result.data : []);
      } catch (error) {
        if (!isMounted || error.name === 'AbortError') return;
        setBanner({ type: 'error', message: `Could not load volunteer roster: ${error.message}` });
      } finally {
        if (isMounted) setLoadingVolunteers(false);
      }
    }

    loadVolunteerRoster();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [isOwner, isVolunteerEvent, post?.id]);

  async function handleVote(direction) {
    if (!post || !post.id) return;
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to vote on posts.' });
      return;
    }

    const currentVote = post?.userVote === 'up' ? 'up' : post?.userVote === 'down' ? 'down' : null;
    const nextVote = currentVote === direction ? 'none' : direction;
    const beforeScore = getBaseVoteScore(post);
    const beforeUpvoteCount = Number.isFinite(Number(post?.upvoteCount)) ? Math.max(0, Math.trunc(Number(post.upvoteCount))) : 0;
    const beforeDownvoteCount = Number.isFinite(Number(post?.downvoteCount)) ? Math.max(0, Math.trunc(Number(post.downvoteCount))) : 0;

    const currentNumeric = currentVote === 'up' ? 1 : currentVote === 'down' ? -1 : 0;
    const nextNumeric = nextVote === 'up' ? 1 : nextVote === 'down' ? -1 : 0;
    const delta = nextNumeric - currentNumeric;

    setPost((prev) => (prev ? {
      ...prev,
      score: beforeScore + delta,
      voteScore: beforeScore + delta,
      upvoteCount: beforeUpvoteCount + (nextNumeric === 1 ? 1 : 0) - (currentNumeric === 1 ? 1 : 0),
      downvoteCount: beforeDownvoteCount + (nextNumeric === -1 ? 1 : 0) - (currentNumeric === -1 ? 1 : 0),
      userVote: nextNumeric === 1 ? 'up' : nextNumeric === -1 ? 'down' : null,
    } : prev));

    setActionBusy(true);
    try {
      const result = await apiRequest(`/posts/posts/${post.id}/vote`, {
        method: 'POST',
        body: JSON.stringify({ vote: nextVote }),
      });
      const payload = result?.data || {};
      setPost((prev) => (prev ? {
        ...prev,
        score: Number.isFinite(Number(payload.score)) ? Math.trunc(Number(payload.score)) : beforeScore,
        voteScore: Number.isFinite(Number(payload.voteScore)) ? Math.trunc(Number(payload.voteScore)) : beforeScore,
        upvoteCount: Number.isFinite(Number(payload.upvoteCount)) ? Math.max(0, Math.trunc(Number(payload.upvoteCount))) : beforeUpvoteCount,
        downvoteCount: Number.isFinite(Number(payload.downvoteCount)) ? Math.max(0, Math.trunc(Number(payload.downvoteCount))) : beforeDownvoteCount,
        userVote: payload.userVote === 'up' ? 'up' : payload.userVote === 'down' ? 'down' : null,
      } : prev));
    } catch (error) {
      setPost((prev) => (prev ? {
        ...prev,
        score: beforeScore,
        voteScore: beforeScore,
        upvoteCount: beforeUpvoteCount,
        downvoteCount: beforeDownvoteCount,
        userVote: currentVote,
      } : prev));
      setBanner({ type: 'error', message: `Vote failed: ${error.message}` });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCommentSubmit(event) {
    event.preventDefault();
    const content = commentDraft.trim();
    if (!content || !post?.id) return;
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to comment on posts.' });
      return;
    }

    setActionBusy(true);
    try {
      const result = await apiRequest(`/posts/posts/${post.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      const createdComment = result?.data;
      if (createdComment) {
        setComments((prev) => [createdComment, ...prev]);
      }

      const backendCount = Number(result?.meta?.commentCount);
      if (Number.isFinite(backendCount)) {
        setPost((prev) => (prev ? {
          ...prev,
          commentCount: Math.max(0, Math.trunc(backendCount)),
          commentsCount: Math.max(0, Math.trunc(backendCount)),
        } : prev));
      } else {
        setPost((prev) => (prev ? {
          ...prev,
          commentCount: getCommentCount(prev) + 1,
          commentsCount: getCommentCount(prev) + 1,
        } : prev));
      }

      setCommentDraft('');
    } catch (error) {
      setBanner({ type: 'error', message: `Comment failed: ${error.message}` });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleShare() {
    if (!postId) return;
    setSharingLink(true);
    try {
      const link = typeof window !== 'undefined'
        ? `${window.location.origin}/posts/${postId}`
        : `/posts/${postId}`;

      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard access is unavailable in this browser.');
      }

      await navigator.clipboard.writeText(link);
      setBanner({ type: 'success', message: 'Post link copied to clipboard.' });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not share post: ${error.message}` });
    } finally {
      setSharingLink(false);
    }
  }

  function openVolunteerEnrollment() {
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to enroll as a volunteer.' });
      return;
    }
    if (!isVolunteerEvent) {
      setBanner({ type: 'error', message: 'Volunteer enrollment is only available for EVENT posts.' });
      return;
    }
    if (isOwner) {
      setBanner({ type: 'error', message: 'Event creators cannot enroll themselves as volunteers.' });
      return;
    }
    if (post?.viewerHasVolunteerEnrollment) {
      setBanner({ type: 'success', message: 'You have already enrolled as a volunteer for this event.' });
      return;
    }
    if (isEventOver(post)) {
      setBanner({ type: 'error', message: 'This event has already ended.' });
      return;
    }
    setVolunteerModalOpen(true);
  }

  async function submitVolunteerEnrollment(formValues) {
    if (!post?.id) return;

    setVolunteerBusy(true);
    try {
      const result = await apiRequest(`/posts/posts/${post.id}/volunteers`, {
        method: 'POST',
        body: JSON.stringify(formValues),
      });
      const backendCount = Number(result?.meta?.volunteerCount);
      setPost((prev) => (prev ? {
        ...prev,
        volunteerCount: Number.isFinite(backendCount)
          ? Math.max(0, Math.trunc(backendCount))
          : Math.max(0, Math.trunc(Number(prev?.volunteerCount || 0))) + 1,
        viewerHasVolunteerEnrollment: true,
      } : prev));
      setVolunteerModalOpen(false);
      setBanner({ type: 'success', message: 'Volunteer enrollment submitted. The event creator has been notified.' });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not enroll as volunteer: ${error.message}` });
    } finally {
      setVolunteerBusy(false);
    }
  }

  const postTitle = post?.title || `${toTitleCase(post?.type || 'post')} update`;
  const postSummary = post?.summary || (isJobPost ? jobDetails?.jobDescription : 'No summary provided.');
  const authorLabel = getPostAuthorLabel(post, user);
  const authorAvatar = String(authorLabel || 'U').trim().charAt(0).toUpperCase() || 'U';
  const authorId = post?.author?.id || post?.authorId || null;
  const volunteerCount = Number.isFinite(Number(post?.volunteerCount))
    ? Math.max(0, Math.trunc(Number(post.volunteerCount)))
    : 0;

  function navigateToProfile(event, targetUserId) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    openUserProfile(navigate, targetUserId, currentUserId);
  }

  return (
    <div className="home-feed-page post-details-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      {volunteerModalOpen && (
        <VolunteerEnrollmentModal
          open={volunteerModalOpen}
          post={post}
          submitting={volunteerBusy}
          initialValues={buildVolunteerEnrollmentInitialValues(user)}
          onClose={() => {
            if (volunteerBusy) return;
            setVolunteerModalOpen(false);
          }}
          onSubmit={submitVolunteerEnrollment}
        />
      )}

      <section className={`panel post-details-panel${isEventPost ? ' is-event-post' : ''}`}>
        <div className="post-details-top-row">
          <button className="post-back-btn" type="button" onClick={() => navigate(-1)}>
            {'<'} Back
          </button>
          <div className="post-thread-meta">
            <span className="pill">{post?.type || 'POST'}</span>
            {isVolunteerEvent && <span className="pill">Volunteers {volunteerCount}</span>}
            <span>{post?.createdAt ? formatRelativeTime(post.createdAt) : 'Now'}</span>
          </div>
        </div>

        {loadingPost ? (
          <p className="post-comments-hint">Loading post...</p>
        ) : pageError ? (
          <div className="inline-alert" role="alert">
            <p>{pageError}</p>
            <Link className="btn btn-soft" to="/home">Back to feed</Link>
          </div>
        ) : (
          <>
            <header className="post-detail-header">
              <div className="post-author-chip">
                <button
                  type="button"
                  className="post-avatar post-avatar-button"
                  onClick={(event) => navigateToProfile(event, authorId)}
                  disabled={!authorId}
                >
                  {authorAvatar}
                </button>
                <div>
                  {authorId ? (
                    <button type="button" className="author-inline-btn" onClick={(event) => navigateToProfile(event, authorId)}>
                      {authorLabel}
                    </button>
                  ) : (
                    <strong>{authorLabel}</strong>
                  )}
                  <small>{formatDate(post?.createdAt)}</small>
                </div>
              </div>
              {post?.status && (
                <span className="pill">{toTitleCase(post.status)}</span>
              )}
            </header>

            <h2 className="post-details-title">{postTitle}</h2>

            {isEventPost && <EventMetadataBlock post={post} variant="detail" />}

            {isJobPost && jobDetails && (
              <div className="post-detail-job-row">
                <span className="pill">Company: {jobDetails.companyName}</span>
                <span className="pill">Salary: {jobDetails.salaryRange}</span>
                {jobDetails.deadline && <span className="pill">Apply by {formatDate(jobDetails.deadline)}</span>}
              </div>
            )}

            <p className="post-details-summary">{postSummary}</p>

            {imageRef?.metadata?.imageDataUrl && (
              <div className="post-detail-image-wrap">
                <img src={imageRef.metadata.imageDataUrl} alt={postTitle} loading="lazy" />
              </div>
            )}

            <div className="feed-card-actions social-actions reddit-action-row post-detail-actions">
              <div className="reddit-vote-group" role="group" aria-label={`Voting controls for ${postTitle}`}>
                <button
                  className={`reddit-action-btn vote-btn ${post?.userVote === 'up' ? 'is-active' : ''}`}
                  type="button"
                  aria-label="Upvote"
                  aria-pressed={post?.userVote === 'up'}
                  disabled={actionBusy || post?.status === 'archived'}
                  onClick={() => handleVote('up')}
                >
                  <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true">
                    <polyline points="6 11 10 7 14 11" />
                    <line x1="10" y1="7" x2="10" y2="14" />
                  </svg>
                  <span className="sr-only">Upvote</span>
                </button>
                <span className="reddit-vote-count" aria-live="polite">{formatCompactCount(getBaseVoteScore(post))}</span>
                <button
                  className={`reddit-action-btn vote-btn ${post?.userVote === 'down' ? 'is-active' : ''}`}
                  type="button"
                  aria-label="Downvote"
                  aria-pressed={post?.userVote === 'down'}
                  disabled={actionBusy || post?.status === 'archived'}
                  onClick={() => handleVote('down')}
                >
                  <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true">
                    <polyline points="6 9 10 13 14 9" />
                    <line x1="10" y1="6" x2="10" y2="13" />
                  </svg>
                  <span className="sr-only">Downvote</span>
                </button>
              </div>

              <button
                className="reddit-action-btn reddit-metric-btn"
                type="button"
                aria-label={`Comments ${getCommentCount(post)}`}
                onClick={() => document.getElementById('post-comments-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M4.5 4.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3H4.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
                </svg>
                <span className="reddit-action-count">{formatCompactCount(getCommentCount(post))}</span>
                <span className="sr-only">Comments</span>
              </button>

                <button
                  className="reddit-action-btn reddit-metric-btn reddit-share-btn"
                  type="button"
                  disabled={sharingLink}
                  onClick={handleShare}
                >
                  <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M12 5 16 9 12 13" />
                    <path d="M16 9H8a4 4 0 0 0-4 4" />
                  </svg>
                  <span>{sharingLink ? 'Sharing...' : 'Share'}</span>
                </button>

              {isVolunteerEvent && !isOwner && (
                <button
                  className="reddit-action-btn reddit-metric-btn event-volunteer-btn"
                  type="button"
                  disabled={volunteerBusy || post?.status === 'archived' || Boolean(post?.viewerHasVolunteerEnrollment) || isEventOver(post)}
                  onClick={openVolunteerEnrollment}
                >
                  {post?.viewerHasVolunteerEnrollment
                    ? 'Already Enrolled'
                    : isEventOver(post)
                      ? 'Event Ended'
                      : volunteerBusy
                        ? 'Submitting...'
                        : 'Enroll as Volunteer'}
                </button>
              )}

              {isCollabPost && post?.id && (
                <Link
                  className="btn btn-soft"
                  to={`/collaborate/${encodeURIComponent(String(post.id))}`}
                >
                  View Collab Details
                </Link>
              )}

              {isJobPost && !isOwner && (
                isAuthenticated ? (
                  <Link
                    className="btn btn-primary-solid"
                    to={`/job-portal/${post.id}/apply`}
                    state={{
                      fromJobPortal: true,
                      postId: post.id,
                      jobTitle: jobDetails?.jobTitle,
                      companyName: jobDetails?.companyName,
                    }}
                  >
                    Apply Now
                  </Link>
                ) : (
                  <Link className="btn btn-soft" to="/login">Sign in to Apply</Link>
                )
              )}

              {canViewApplications && (
                <Link
                  className="btn btn-soft"
                  to={`/job-portal/${post.id}/applications`}
                  state={{ fromViewApplications: true, postId: post.id }}
                >
                  View Applications
                </Link>
              )}
            </div>

            <form className="post-join-form" onSubmit={handleCommentSubmit}>
              <input
                id="post-comments-anchor"
                type="text"
                placeholder={isAuthenticated ? 'Join the conversation' : 'Sign in to join the conversation'}
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
                disabled={!isAuthenticated || actionBusy}
              />
              <button
                className="btn btn-primary-solid"
                type="submit"
                disabled={!isAuthenticated || actionBusy || !commentDraft.trim()}
              >
                Comment
              </button>
            </form>

            {isVolunteerEvent && isOwner && (
              <section className="event-roster-panel" aria-label="Volunteer roster">
                <div className="post-comments-header">
                  <h5>Volunteer Roster</h5>
                </div>

                {loadingVolunteers ? (
                  <p className="post-comments-hint">Loading volunteer roster...</p>
                ) : volunteers.length === 0 ? (
                  <p className="post-comments-hint">No volunteers have enrolled yet.</p>
                ) : (
                  <div className="event-roster-table-shell">
                    <div className="event-roster-table-wrap">
                      <table className="event-roster-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Contact</th>
                            <th>Reason</th>
                            <th>Availability</th>
                            <th>Notes</th>
                            <th>Submitted</th>
                          </tr>
                        </thead>
                        <tbody>
                          {volunteers.map((entry) => (
                            <tr key={entry.id}>
                              <td><div className="event-roster-cell">{entry.fullName}</div></td>
                              <td><div className="event-roster-cell">{entry.contactInfo}</div></td>
                              <td><div className="event-roster-cell">{entry.reason}</div></td>
                              <td><div className="event-roster-cell">{entry.availability || 'Not provided'}</div></td>
                              <td><div className="event-roster-cell">{entry.notes || 'Not provided'}</div></td>
                              <td><div className="event-roster-cell is-compact">{formatDate(entry.createdAt)}</div></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
            )}

            {loadingComments ? (
              <p className="post-comments-hint">Loading comments...</p>
            ) : comments.length === 0 ? (
              <p className="post-comments-hint">No comments yet. Start the discussion.</p>
            ) : (
              <ul className="post-detail-comment-list" aria-label="Post comments">
                {comments.map((comment, index) => (
                  <li
                    key={comment.id || `${comment.authorId || 'comment'}-${index}`}
                    className={`post-detail-comment-item${index === 0 ? ' is-featured' : ''}`}
                  >
                    <div className="post-comment-head">
                      {comment.authorId ? (
                        <button
                          type="button"
                          className="author-inline-btn"
                          onClick={(event) => navigateToProfile(event, comment.authorId)}
                        >
                          {getCommentAuthorLabel(comment, user)}
                        </button>
                      ) : (
                        <strong>{getCommentAuthorLabel(comment, user)}</strong>
                      )}
                      <small>{formatDate(comment.createdAt)}</small>
                    </div>
                    <p>{comment.content || 'No comment text provided.'}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
