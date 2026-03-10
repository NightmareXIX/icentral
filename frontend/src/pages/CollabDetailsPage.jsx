import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { openUserProfile } from '../utils/profileNavigation';
import {
  COLLAB_STATUSES,
  REQUEST_STATUS,
  getCollabOpeningsLeft,
  getCollabPendingRequestCount,
  getCollabPostById,
  getCollabRequestForUser,
  reviewCollabJoinRequest,
  setCollabPostStatus,
  submitCollabJoinRequest,
} from '../utils/collabApi';

function formatDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function normalizeRequestStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === REQUEST_STATUS.ACCEPTED) return REQUEST_STATUS.ACCEPTED;
  if (normalized === REQUEST_STATUS.REJECTED) return REQUEST_STATUS.REJECTED;
  return REQUEST_STATUS.PENDING;
}

function getRequestStatusLabel(status) {
  if (status === REQUEST_STATUS.ACCEPTED) return 'Accepted';
  if (status === REQUEST_STATUS.REJECTED) return 'Rejected';
  return 'Pending';
}

export default function CollabDetailsPage() {
  const { collabId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const joinMessageInputRef = useRef(null);
  const { isAuthenticated, user } = useAuth();
  const currentUserId = String(user?.id || '').trim();

  const [post, setPost] = useState(null);
  const [loadingPost, setLoadingPost] = useState(true);
  const [pageError, setPageError] = useState('');
  const [banner, setBanner] = useState({ type: 'idle', message: '' });
  const [joinMessage, setJoinMessage] = useState('');
  const [busyAction, setBusyAction] = useState(false);
  const [busyRequestId, setBusyRequestId] = useState('');

  useEffect(() => {
    let isMounted = true;

    async function loadPost() {
      if (!collabId) {
        if (!isMounted) return;
        setPost(null);
        setPageError('Missing collaboration post id.');
        setLoadingPost(false);
        return;
      }

      if (isMounted) setLoadingPost(true);
      try {
        const found = await getCollabPostById(collabId);
        if (!isMounted) return;

        if (!found) {
          setPost(null);
          setPageError('Collaboration post not found.');
          setLoadingPost(false);
          return;
        }

        setPost(found);
        setPageError('');
      } catch (error) {
        if (!isMounted) return;
        setPost(null);
        setPageError(`Could not load collaboration post: ${error.message}`);
      } finally {
        if (isMounted) setLoadingPost(false);
      }
    }

    loadPost();

    return () => {
      isMounted = false;
    };
  }, [collabId]);

  const isOpen = String(post?.status || '').toUpperCase() === COLLAB_STATUSES.OPEN;
  const openingsLeft = getCollabOpeningsLeft(post);
  const pendingRequestCount = getCollabPendingRequestCount(post);
  const creatorId = String(post?.creator?.id || '').trim();
  const creatorName = String(post?.creator?.name || 'Community member');
  const creatorRole = String(post?.creator?.role || 'Member');
  const isOwner = creatorId && currentUserId && creatorId === currentUserId;
  const currentUserRequest = getCollabRequestForUser(post, currentUserId);
  const currentUserRequestStatus = currentUserRequest
    ? normalizeRequestStatus(currentUserRequest.status)
    : null;

  const pendingRequests = useMemo(() => {
    const requests = Array.isArray(post?.requests) ? post.requests : [];
    return requests.filter((request) => normalizeRequestStatus(request.status) === REQUEST_STATUS.PENDING);
  }, [post?.requests]);

  const reviewedRequests = useMemo(() => {
    const requests = Array.isArray(post?.requests) ? post.requests : [];
    return requests.filter((request) => normalizeRequestStatus(request.status) !== REQUEST_STATUS.PENDING);
  }, [post?.requests]);

  const canSubmitRequest = isAuthenticated
    && !isOwner
    && isOpen
    && currentUserRequestStatus !== REQUEST_STATUS.PENDING
    && currentUserRequestStatus !== REQUEST_STATUS.ACCEPTED;

  useEffect(() => {
    if (!location.state?.openJoinComposer || !canSubmitRequest) return;
    joinMessageInputRef.current?.focus();
  }, [canSubmitRequest, location.state]);

  function navigateToCreatorProfile(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!creatorId) return;
    openUserProfile(navigate, creatorId, currentUserId);
  }

  async function handleJoinRequest(event) {
    event.preventDefault();
    if (!post?.id) return;

    const message = joinMessage.trim();
    if (!message) {
      setBanner({ type: 'error', message: 'Please include a short message with your request.' });
      return;
    }
    if (message.length < 12) {
      setBanner({ type: 'error', message: 'Join request message should be at least 12 characters.' });
      return;
    }

    setBusyAction(true);
    try {
      const updated = await submitCollabJoinRequest(post.id, user, message);
      setPost(updated);
      setJoinMessage('');
      setBanner({ type: 'success', message: 'Join request submitted.' });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not submit request: ${error.message}` });
    } finally {
      setBusyAction(false);
    }
  }

  async function handleRequestDecision(requestId, nextStatus) {
    if (!post?.id) return;
    setBusyRequestId(requestId);
    try {
      const updated = await reviewCollabJoinRequest(post.id, requestId, nextStatus, user);
      setPost(updated);
      setBanner({
        type: 'success',
        message: nextStatus === REQUEST_STATUS.ACCEPTED
          ? 'Join request accepted.'
          : 'Join request rejected.',
      });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not update request: ${error.message}` });
    } finally {
      setBusyRequestId('');
    }
  }

  async function handleToggleStatus() {
    if (!post?.id) return;
    const nextStatus = isOpen ? COLLAB_STATUSES.CLOSED : COLLAB_STATUSES.OPEN;
    setBusyAction(true);
    try {
      const updated = await setCollabPostStatus(post.id, nextStatus, user);
      setPost(updated);
      setBanner({
        type: 'success',
        message: nextStatus === COLLAB_STATUSES.CLOSED
          ? 'Collaboration post closed.'
          : 'Collaboration post reopened.',
      });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not change post status: ${error.message}` });
    } finally {
      setBusyAction(false);
    }
  }

  return (
    <div className="home-feed-page collab-details-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      <section className="panel post-details-panel collab-details-panel">
        <div className="post-details-top-row">
          <button className="post-back-btn" type="button" onClick={() => navigate(-1)}>
            {'<'} Back
          </button>
          <div className="post-thread-meta">
            <span className="pill">{post?.category || 'Collaboration'}</span>
            <span>{isOpen ? 'Open opportunity' : 'Closed opportunity'}</span>
          </div>
        </div>

        {loadingPost ? (
          <p className="post-comments-hint">Loading collaboration post...</p>
        ) : pageError ? (
          <div className="inline-alert" role="alert">
            <p>{pageError}</p>
            <Link className="btn btn-soft" to="/collaborate">Back to Collaborate</Link>
          </div>
        ) : (
          <>
            <header className="post-detail-header">
              <div className="post-author-chip">
                <button
                  type="button"
                  className="post-avatar post-avatar-button"
                  onClick={navigateToCreatorProfile}
                  disabled={!creatorId}
                >
                  C
                </button>
                <div>
                  {creatorId ? (
                    <button type="button" className="author-inline-btn" onClick={navigateToCreatorProfile}>
                      {creatorName}
                    </button>
                  ) : (
                    <strong>{creatorName}</strong>
                  )}
                  <small>{creatorRole} - Posted {formatDate(post?.createdAt)}</small>
                </div>
              </div>
              <div className="pill-row">
                <span className={`pill ${isOpen ? 'tone-ok' : 'tone-muted'}`}>{post?.status || 'OPEN'}</span>
                <span className="pill">Pending requests: {pendingRequestCount}</span>
              </div>
            </header>

            <h2 className="post-details-title">{post?.title || 'Collaboration opportunity'}</h2>
            <p className="post-details-summary">{post?.summary || 'No summary provided.'}</p>

            <div className="collab-details-meta-grid">
              <div className="collab-details-meta-item">
                <strong>Mode</strong>
                <span>{post?.mode || 'HYBRID'}</span>
              </div>
              <div className="collab-details-meta-item">
                <strong>Time commitment</strong>
                <span>{post?.timeCommitmentHoursPerWeek || 0} hours/week</span>
              </div>
              <div className="collab-details-meta-item">
                <strong>Timeline</strong>
                <span>{post?.duration || 'Not specified'}</span>
              </div>
              <div className="collab-details-meta-item">
                <strong>Open positions</strong>
                <span>{openingsLeft} of {post?.openings || 1} remaining</span>
              </div>
              <div className="collab-details-meta-item">
                <strong>Join until</strong>
                <span>{post?.joinUntil ? formatDate(post.joinUntil) : 'No deadline'}</span>
              </div>
              <div className="collab-details-meta-item">
                <strong>Preferred background</strong>
                <span>{post?.preferredBackground || 'Not specified'}</span>
              </div>
            </div>

            {Array.isArray(post?.requiredSkills) && post.requiredSkills.length > 0 && (
              <div className="collab-detail-section">
                <h4>Required skills</h4>
                <ul className="mini-tag-row" aria-label="Required skills">
                  {post.requiredSkills.map((skill) => (
                    <li key={`${post.id}-${skill}`}>
                      <span className="mini-tag">{skill}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="collab-detail-section">
              <h4>Full description</h4>
              <p className="collab-full-description">{post?.description || 'No description provided.'}</p>
            </div>

            <div className="feed-card-actions post-detail-actions collab-detail-actions">
              <Link className="btn btn-soft" to="/collaborate">Back to Collaborate</Link>

              {isOwner ? (
                <button
                  className="btn btn-accent"
                  type="button"
                  disabled={busyAction}
                  onClick={handleToggleStatus}
                >
                  {busyAction
                    ? 'Updating...'
                    : isOpen
                      ? 'Close Collaboration'
                      : 'Reopen Collaboration'}
                </button>
              ) : null}
            </div>

            {!isOwner && (
              <section className="collab-detail-section">
                <h4>Request to collaborate</h4>

                {!isAuthenticated ? (
                  <div className="inline-alert warn-alert">
                    <p>
                      You need to sign in to submit a collaboration request.
                      <Link to="/login"> Sign in</Link>.
                    </p>
                  </div>
                ) : (
                  <>
                    {currentUserRequestStatus && (
                      <p className="collab-request-status-line">
                        Your current request status:
                        <span className={`pill collab-request-pill is-${currentUserRequestStatus.toLowerCase()}`}>
                          {getRequestStatusLabel(currentUserRequestStatus)}
                        </span>
                      </p>
                    )}

                    {canSubmitRequest && (
                      <form className="stacked-form collab-join-form" onSubmit={handleJoinRequest}>
                        <label>
                          <span>Message for the post owner</span>
                          <textarea
                            ref={joinMessageInputRef}
                            rows={4}
                            placeholder="Introduce your background, relevant skills, and why you are interested."
                            value={joinMessage}
                            onChange={(event) => setJoinMessage(event.target.value)}
                            disabled={busyAction}
                          />
                        </label>
                        <div className="feed-card-actions collab-request-actions">
                          <button className="btn btn-primary-solid" type="submit" disabled={busyAction || !joinMessage.trim()}>
                            {busyAction ? 'Submitting...' : 'Send Join Request'}
                          </button>
                        </div>
                      </form>
                    )}
                  </>
                )}
              </section>
            )}

            {isOwner && (
              <>
                <section className="collab-detail-section">
                  <div className="collab-section-head">
                    <h4>Pending join requests</h4>
                    <span className="pill">{pendingRequests.length}</span>
                  </div>

                  {pendingRequests.length === 0 ? (
                    <p className="post-comments-hint">No pending requests yet.</p>
                  ) : (
                    <ul className="collab-request-list" aria-label="Pending join requests">
                      {pendingRequests.map((request) => (
                        <li key={request.id} className="collab-request-item">
                          <div className="collab-request-item-head">
                            <div>
                              <strong>{request.applicantName}</strong>
                              <small>{request.applicantRole} - {formatDate(request.createdAt)}</small>
                            </div>
                            <span className="pill collab-request-pill is-pending">Pending</span>
                          </div>
                          <p>{request.message || 'No message provided.'}</p>
                          <div className="feed-card-actions collab-request-actions">
                            <button
                              className="btn btn-primary-solid"
                              type="button"
                              disabled={busyRequestId === request.id}
                              onClick={() => handleRequestDecision(request.id, REQUEST_STATUS.ACCEPTED)}
                            >
                              {busyRequestId === request.id ? 'Updating...' : 'Accept'}
                            </button>
                            <button
                              className="btn btn-danger-soft"
                              type="button"
                              disabled={busyRequestId === request.id}
                              onClick={() => handleRequestDecision(request.id, REQUEST_STATUS.REJECTED)}
                            >
                              {busyRequestId === request.id ? 'Updating...' : 'Reject'}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="collab-detail-section">
                  <h4>Accepted collaborators</h4>
                  {Array.isArray(post?.collaborators) && post.collaborators.length > 0 ? (
                    <ul className="collab-member-list" aria-label="Accepted collaborators">
                      {post.collaborators.map((member) => (
                        <li key={`${member.userId}-${member.acceptedAt}`} className="collab-member-item">
                          <strong>{member.name}</strong>
                          <small>{member.role} - Accepted {formatDate(member.acceptedAt)}</small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="post-comments-hint">No collaborators have been accepted yet.</p>
                  )}
                </section>

                <section className="collab-detail-section">
                  <h4>Request history</h4>
                  {reviewedRequests.length === 0 ? (
                    <p className="post-comments-hint">Accepted/rejected requests will appear here.</p>
                  ) : (
                    <ul className="collab-member-list" aria-label="Reviewed requests">
                      {reviewedRequests.map((request) => {
                        const status = normalizeRequestStatus(request.status);
                        return (
                          <li key={request.id} className="collab-member-item">
                            <strong>
                              {request.applicantName}
                              <span className={`pill collab-request-pill is-${status.toLowerCase()}`}>
                                {getRequestStatusLabel(status)}
                              </span>
                            </strong>
                            <small>{request.applicantRole} - Reviewed {formatDate(request.reviewedAt)}</small>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
