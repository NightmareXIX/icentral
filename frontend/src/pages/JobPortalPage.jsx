import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import PostActionsMenu from '../components/posts/PostActionsMenu';
import PostEditModal from '../components/posts/PostEditModal';
import { getJobDetailsFromPost } from '../utils/jobPortalStorage';
import { getPostLabel, isFacultyUser } from '../utils/postManagement';
import { openUserProfile } from '../utils/profileNavigation';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

const initialPostForm = {
  jobTitle: '',
  companyName: '',
  jobDescription: '',
  salaryRange: '',
  expiresAt: '',
};

const FEED_PAGE_LIMIT = 50;
const CARD_NAV_IGNORE_SELECTOR = 'a,button,input,textarea,select,label,[role="button"],.post-comments-panel,[data-prevent-card-nav="true"]';
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

export default function JobPortalPage() {
  const navigate = useNavigate();
  const { token, isAuthenticated, user, setAuthSession } = useAuth();
  const [feedItems, setFeedItems] = useState([]);
  const [postForm, setPostForm] = useState(initialPostForm);
  const [searchInput, setSearchInput] = useState('');
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [submittingPost, setSubmittingPost] = useState(false);
  const [banner, setBanner] = useState({ type: 'idle', message: '' });
  const [feedError, setFeedError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [verificationStatus, setVerificationStatus] = useState('not_submitted');
  const [loadingVerification, setLoadingVerification] = useState(false);
  const [actionBusyPostId, setActionBusyPostId] = useState(null);
  const [openCommentsPostId, setOpenCommentsPostId] = useState(null);
  const [commentsByPostId, setCommentsByPostId] = useState({});
  const [commentsLoadingPostId, setCommentsLoadingPostId] = useState(null);
  const [commentsSubmittingPostId, setCommentsSubmittingPostId] = useState(null);
  const [commentDrafts, setCommentDrafts] = useState({});
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);

  const deferredSearch = useDeferredValue(searchInput);
  const activeSearch = deferredSearch.trim().toLowerCase();
  const currentUserId = String(user?.id || '').trim();
  const normalizedRole = String(user?.role || '').toLowerCase();
  const canPinPosts = isFacultyUser(user);
  const isAlumni = normalizedRole === 'alumni';
  const isFacultyOrAdmin = normalizedRole === 'faculty' || normalizedRole === 'admin';
  const fallbackStatus = String(user?.alumniVerificationStatus || '').toLowerCase();
  const effectiveVerificationStatus = verificationStatus || fallbackStatus || 'not_submitted';
  const canCreateJobPost = isAuthenticated && (isFacultyOrAdmin || (isAlumni && effectiveVerificationStatus === 'approved'));

  const filteredFeedItems = useMemo(() => {
    const visiblePosts = feedItems
      .filter((post) => String(post?.status || '').toLowerCase() !== 'archived')
      .slice()
      .sort((a, b) => {
        const voteDelta = getBaseVoteScore(b) - getBaseVoteScore(a);
        if (voteDelta !== 0) return voteDelta;
        const createdAtA = Number(new Date(a?.createdAt || 0));
        const createdAtB = Number(new Date(b?.createdAt || 0));
        return createdAtB - createdAtA;
      });

    if (!activeSearch) return visiblePosts;

    return visiblePosts.filter((post) => {
      const details = getJobDetailsFromPost(post);
      const searchable = [
        details.jobTitle,
        details.companyName,
        details.jobDescription,
        details.salaryRange,
      ].join(' ').toLowerCase();
      return searchable.includes(activeSearch);
    });
  }, [feedItems, activeSearch]);

  const uniqueCompaniesCount = useMemo(() => {
    return new Set(feedItems.map((post) => getJobDetailsFromPost(post).companyName)).size;
  }, [feedItems]);

  const myPostsCount = useMemo(() => {
    if (!user?.id) return 0;
    return feedItems.filter((post) => String(post.authorId || '') === String(user.id)).length;
  }, [feedItems, user?.id]);

  useEffect(() => {
    let isMounted = true;

    async function loadMyVerificationStatus() {
      if (!isAuthenticated || !isAlumni) {
        if (!isMounted) return;
        setVerificationStatus('not_submitted');
        return;
      }

      setLoadingVerification(true);
      try {
        const result = await apiRequest('/users/alumni-verification/me');
        if (!isMounted) return;

        const status = String(result?.data?.status || 'not_submitted').toLowerCase();
        setVerificationStatus(status);

        if (token && user) {
          setAuthSession({
            token,
            user: {
              ...user,
              alumniVerificationStatus: status,
              isVerifiedAlumni: status === 'approved',
            },
          });
        }
      } catch {
        if (!isMounted) return;
        setVerificationStatus(fallbackStatus || 'not_submitted');
      } finally {
        if (isMounted) setLoadingVerification(false);
      }
    }

    loadMyVerificationStatus();
    return () => {
      isMounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isAlumni]);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function loadFeed() {
      setLoadingFeed(true);
      setFeedError('');

      try {
        const params = new URLSearchParams();
        params.set('type', 'JOB');
        params.set('status', 'published');
        params.set('limit', String(FEED_PAGE_LIMIT));
        params.set('offset', '0');

        const result = await apiRequest(`/posts/feed?${params.toString()}`, {
          signal: controller.signal,
        });

        const items = Array.isArray(result.data)
          ? result.data.filter((item) => String(item?.type || '').toUpperCase() === 'JOB')
          : [];

        if (!isMounted) return;

        startTransition(() => {
          setFeedItems(items);
        });
      } catch (error) {
        if (!isMounted || error.name === 'AbortError') return;
        setFeedError(error.message);
      } finally {
        if (isMounted) setLoadingFeed(false);
      }
    }

    loadFeed();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [refreshTick]);

  useEffect(() => {
    if (!isCreateModalOpen) return undefined;

    function handleEscapeKey(event) {
      if (event.key === 'Escape') {
        if (submittingPost) return;
        setIsCreateModalOpen(false);
      }
    }

    window.addEventListener('keydown', handleEscapeKey);
    return () => {
      window.removeEventListener('keydown', handleEscapeKey);
    };
  }, [isCreateModalOpen, submittingPost]);

  function refreshFeed() {
    setRefreshTick((prev) => prev + 1);
  }

  function updatePostField(field, value) {
    setPostForm((prev) => ({ ...prev, [field]: value }));
  }

  function shouldIgnoreCardNavigation(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(CARD_NAV_IGNORE_SELECTOR));
  }

  function openPostDetails(postId) {
    if (!postId) return;
    navigate(`/posts/${postId}`);
  }

  function navigateToProfile(event, targetUserId) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    openUserProfile(navigate, targetUserId, currentUserId);
  }

  function handleCardNavigation(event, postId) {
    if (!postId || shouldIgnoreCardNavigation(event.target)) return;
    openPostDetails(postId);
  }

  function handleCardKeyNavigation(event, postId) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!postId || shouldIgnoreCardNavigation(event.target)) return;
    event.preventDefault();
    openPostDetails(postId);
  }

  function updatePostEngagement(postId, patch) {
    setFeedItems((prev) => prev.map((item) => {
      if (item.id !== postId) return item;
      return { ...item, ...patch };
    }));
  }

  function handleEditedPostSaved(updatedPost) {
    if (!updatedPost?.id) return;
    setFeedItems((prev) => prev.map((item) => (
      item.id === updatedPost.id
        ? { ...item, ...updatedPost }
        : item
    )));
  }

  function isPostOwner(post) {
    if (!post?.authorId || !user?.id) return false;
    return String(post.authorId) === String(user.id);
  }

  async function patchPost(postId, payload, successMessage) {
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to update posts.' });
      return;
    }

    setActionBusyPostId(postId);
    try {
      await apiRequest(`/posts/posts/${postId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setBanner({ type: 'success', message: successMessage });
      refreshFeed();
    } catch (error) {
      setBanner({ type: 'error', message: `Post update failed: ${error.message}` });
    } finally {
      setActionBusyPostId(null);
    }
  }

  async function deletePost(post) {
    const postId = post?.id;
    if (!postId) return;

    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to delete posts.' });
      return;
    }

    const canDelete = isFacultyOrAdmin || isPostOwner(post);
    if (!canDelete) {
      setBanner({ type: 'error', message: 'Only faculty/admin or the original author can delete this post.' });
      return;
    }

    const details = getJobDetailsFromPost(post);
    const label = (details.jobTitle || '').trim() || 'job post';
    const confirmed = window.confirm(`Delete "${label}" permanently?`);
    if (!confirmed) return;

    setActionBusyPostId(postId);
    try {
      await apiRequest(`/posts/posts/${postId}`, { method: 'DELETE' });
      setBanner({ type: 'success', message: 'Job post deleted.' });
      if (openCommentsPostId === postId) setOpenCommentsPostId(null);
      setCommentsByPostId((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, postId)) return prev;
        const next = { ...prev };
        delete next[postId];
        return next;
      });
      refreshFeed();
    } catch (error) {
      setBanner({ type: 'error', message: `Post delete failed: ${error.message}` });
    } finally {
      setActionBusyPostId(null);
    }
  }

  async function handleVote(post, direction) {
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to vote on job posts.' });
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

    updatePostEngagement(post.id, {
      score: beforeScore + delta,
      voteScore: beforeScore + delta,
      upvoteCount: beforeUpvoteCount + (nextNumeric === 1 ? 1 : 0) - (currentNumeric === 1 ? 1 : 0),
      downvoteCount: beforeDownvoteCount + (nextNumeric === -1 ? 1 : 0) - (currentNumeric === -1 ? 1 : 0),
      userVote: nextNumeric === 1 ? 'up' : nextNumeric === -1 ? 'down' : null,
    });

    setActionBusyPostId(post.id);
    try {
      const result = await apiRequest(`/posts/posts/${post.id}/vote`, {
        method: 'POST',
        body: JSON.stringify({ vote: nextVote }),
      });

      const payload = result?.data || {};
      updatePostEngagement(post.id, {
        score: Number.isFinite(Number(payload.score)) ? Math.trunc(Number(payload.score)) : beforeScore,
        voteScore: Number.isFinite(Number(payload.voteScore)) ? Math.trunc(Number(payload.voteScore)) : beforeScore,
        upvoteCount: Number.isFinite(Number(payload.upvoteCount)) ? Math.max(0, Math.trunc(Number(payload.upvoteCount))) : beforeUpvoteCount,
        downvoteCount: Number.isFinite(Number(payload.downvoteCount)) ? Math.max(0, Math.trunc(Number(payload.downvoteCount))) : beforeDownvoteCount,
        userVote: payload.userVote === 'up' ? 'up' : payload.userVote === 'down' ? 'down' : null,
      });
    } catch (error) {
      updatePostEngagement(post.id, {
        score: beforeScore,
        voteScore: beforeScore,
        upvoteCount: beforeUpvoteCount,
        downvoteCount: beforeDownvoteCount,
        userVote: currentVote,
      });
      setBanner({ type: 'error', message: `Vote failed: ${error.message}` });
    } finally {
      setActionBusyPostId(null);
    }
  }

  async function loadComments(postId, options = {}) {
    const { openAfterLoad = true } = options;
    setCommentsLoadingPostId(postId);
    try {
      const result = await apiRequest(`/posts/posts/${postId}/comments?limit=100&offset=0`);
      const comments = Array.isArray(result?.data) ? result.data : [];
      const total = Number(result?.pagination?.total);
      setCommentsByPostId((prev) => ({ ...prev, [postId]: comments }));
      updatePostEngagement(postId, {
        commentCount: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : comments.length,
        commentsCount: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : comments.length,
      });
      if (openAfterLoad) {
        setOpenCommentsPostId(postId);
      }
    } catch (error) {
      setBanner({ type: 'error', message: `Could not load comments: ${error.message}` });
    } finally {
      setCommentsLoadingPostId(null);
    }
  }

  async function toggleComments(post) {
    if (openCommentsPostId === post.id) {
      setOpenCommentsPostId(null);
      return;
    }

    if (Array.isArray(commentsByPostId[post.id])) {
      setOpenCommentsPostId(post.id);
      return;
    }

    await loadComments(post.id, { openAfterLoad: true });
  }

  async function submitComment(postId) {
    const draftValue = commentDrafts[postId] || '';
    const content = draftValue.trim();
    if (!content) return;
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to comment on job posts.' });
      return;
    }

    setCommentsSubmittingPostId(postId);
    try {
      const result = await apiRequest(`/posts/posts/${postId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });

      const createdComment = result?.data;
      if (createdComment) {
        setCommentsByPostId((prev) => ({
          ...prev,
          [postId]: [createdComment, ...(Array.isArray(prev[postId]) ? prev[postId] : [])],
        }));
      }
      setCommentDrafts((prev) => ({ ...prev, [postId]: '' }));

      const backendCount = Number(result?.meta?.commentCount);
      if (Number.isFinite(backendCount)) {
        updatePostEngagement(postId, {
          commentCount: Math.max(0, Math.trunc(backendCount)),
          commentsCount: Math.max(0, Math.trunc(backendCount)),
        });
      } else {
        setFeedItems((prev) => prev.map((item) => {
          if (item.id !== postId) return item;
          const nextCount = getCommentCount(item) + 1;
          return { ...item, commentCount: nextCount, commentsCount: nextCount };
        }));
      }
    } catch (error) {
      setBanner({ type: 'error', message: `Comment failed: ${error.message}` });
    } finally {
      setCommentsSubmittingPostId(null);
    }
  }

  async function handleCreatePost(event) {
    event.preventDefault();

    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to create job posts.' });
      return;
    }

    if (!canCreateJobPost) {
      setBanner({
        type: 'error',
        message: (!isAlumni && !isFacultyOrAdmin)
          ? 'Only verified alumni or faculty/admin can post in the Job Portal.'
          : effectiveVerificationStatus === 'pending'
            ? 'Your alumni verification is still pending review.'
            : 'Only verified alumni can post in the Job Portal.',
      });
      return;
    }

    const jobTitle = postForm.jobTitle.trim();
    const companyName = postForm.companyName.trim();
    const jobDescription = postForm.jobDescription.trim();
    const salaryRange = postForm.salaryRange.trim();
    const expiresAtInput = postForm.expiresAt.trim();

    if (!jobTitle || !companyName || !jobDescription || !salaryRange || !expiresAtInput) {
      setBanner({ type: 'error', message: 'All job fields, including the application deadline, are required.' });
      return;
    }

    const expiresAtDate = new Date(expiresAtInput);
    if (Number.isNaN(expiresAtDate.getTime())) {
      setBanner({ type: 'error', message: 'Application deadline is invalid.' });
      return;
    }

    if (expiresAtDate.getTime() <= Date.now()) {
      setBanner({ type: 'error', message: 'Application deadline must be in the future.' });
      return;
    }

    const maybeAuthorId = user?.id && /^[0-9a-fA-F-]{32,36}$/.test(String(user.id)) ? user.id : undefined;
    const refEntityId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `job-details-${Date.now()}`;

    const payload = {
      type: 'JOB',
      title: jobTitle,
      summary: jobDescription,
      status: 'published',
      expiresAt: expiresAtDate.toISOString(),
      ref: {
        service: 'job-details',
        entityId: refEntityId,
        metadata: {
          jobTitle,
          companyName,
          jobDescription,
          salaryRange,
        },
      },
      ...(maybeAuthorId ? { authorId: maybeAuthorId } : {}),
    };

    setSubmittingPost(true);
    try {
      await apiRequest('/posts/posts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setPostForm(initialPostForm);
      setBanner({ type: 'success', message: 'Job post created successfully.' });
      setIsCreateModalOpen(false);
      refreshFeed();
    } catch (error) {
      setBanner({ type: 'error', message: `Could not create job post: ${error.message}` });
    } finally {
      setSubmittingPost(false);
    }
  }

  return (
    <div className="home-feed-page job-portal-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      <section className="panel job-portal-overview-panel">
        <div className="job-portal-overview-head">
          <div>
            <p className="eyebrow">Job Portal</p>
            <h2>Professional Opportunities Hub</h2>
            <p>Post opportunities, review quality applicants, and maintain a trusted alumni hiring channel.</p>
          </div>
          <div className="job-overview-stats">
            <div className="job-overview-stat-card">
              <span>Open jobs</span>
              <strong>{feedItems.length}</strong>
            </div>
            <div className="job-overview-stat-card">
              <span>Companies</span>
              <strong>{uniqueCompaniesCount}</strong>
            </div>
            <div className="job-overview-stat-card">
              <span>Your posts</span>
              <strong>{myPostsCount}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="job-portal-top-grid">
        <section className="panel composer-panel job-composer-panel job-composer-compact">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Create</p>
              <h3>Post a Job Opportunity</h3>
            </div>
            <span className="pill pill-ghost">POST /posts/posts</span>
          </div>

          <p className="job-mini-summary">
            Keep the feed focused with a compact composer. Open the popup for the full job posting form.
          </p>

          <ul className="job-mini-points">
            <li>Provide title, company, salary range, description, and deadline</li>
            <li>Applies existing alumni verification and role restrictions</li>
            <li>Posts instantly appear in the Job Portal feed</li>
          </ul>

          <div className="job-composer-footer">
            <button className="btn btn-primary-solid" type="button" onClick={() => setIsCreateModalOpen(true)}>
              Open Job Form
            </button>
          </div>

          {!isAuthenticated && (
            <div className="inline-alert warn-alert">
              <p>
                Guest mode is active. You can browse jobs, but posting requires authentication.
                <Link to="/login"> Sign in</Link> or <Link to="/signup"> create an account</Link>.
              </p>
            </div>
          )}

          {isAuthenticated && !canCreateJobPost && (
            <div className="inline-alert warn-alert">
              <p>
                {!isAlumni && !isFacultyOrAdmin && 'Only verified alumni or faculty/admin can create job posts in this section.'}
                {isAlumni && loadingVerification && 'Checking your alumni verification status...'}
                {isAlumni && !loadingVerification && effectiveVerificationStatus === 'pending' && (
                  <>
                    Your alumni verification is pending. Faculty/Admin approval will unlock job posting.
                  </>
                )}
                {isAlumni && !loadingVerification && (effectiveVerificationStatus === 'not_submitted' || effectiveVerificationStatus === 'rejected') && (
                  <>
                    You need verified alumni status to post jobs.
                    {' '}
                    <Link to="/alumni-verification">Apply for verification</Link>.
                  </>
                )}
              </p>
            </div>
          )}
        </section>
      </section>

      {isCreateModalOpen && (
        <div
          className="profile-edit-backdrop job-create-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Create job post"
          onClick={() => {
            if (submittingPost) return;
            setIsCreateModalOpen(false);
          }}
        >
          <section className="panel profile-edit-modal job-create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Create</p>
                <h3>Post a Job Opportunity</h3>
              </div>
              <button
                type="button"
                className="btn btn-soft"
                onClick={() => setIsCreateModalOpen(false)}
                disabled={submittingPost}
              >
                Close
              </button>
            </div>

            {!isAuthenticated && (
              <div className="inline-alert warn-alert">
                <p>
                  Guest mode is active. You can browse jobs, but posting requires authentication.
                  <Link to="/login"> Sign in</Link> or <Link to="/signup"> create an account</Link>.
                </p>
              </div>
            )}

            {isAuthenticated && !canCreateJobPost && (
              <div className="inline-alert warn-alert">
                <p>
                  {!isAlumni && !isFacultyOrAdmin && 'Only verified alumni or faculty/admin can create job posts in this section.'}
                  {isAlumni && loadingVerification && 'Checking your alumni verification status...'}
                  {isAlumni && !loadingVerification && effectiveVerificationStatus === 'pending' && (
                    <>
                      Your alumni verification is pending. Faculty/Admin approval will unlock job posting.
                    </>
                  )}
                  {isAlumni && !loadingVerification && (effectiveVerificationStatus === 'not_submitted' || effectiveVerificationStatus === 'rejected') && (
                    <>
                      You need verified alumni status to post jobs.
                      {' '}
                      <Link to="/alumni-verification">Apply for verification</Link>.
                    </>
                  )}
                </p>
              </div>
            )}

            <form className="stacked-form job-create-form" onSubmit={handleCreatePost}>
              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Role Details</p>
                  <h4>Position Basics</h4>
                </div>
                <div className="field-row two-col">
                  <label>
                    <span>Job Title</span>
                    <input
                      type="text"
                      placeholder="e.g. Junior Frontend Developer"
                      value={postForm.jobTitle}
                      onChange={(e) => updatePostField('jobTitle', e.target.value)}
                      disabled={!canCreateJobPost}
                    />
                  </label>
                  <label>
                    <span>Company Name</span>
                    <input
                      type="text"
                      placeholder="e.g. TechNova Ltd."
                      value={postForm.companyName}
                      onChange={(e) => updatePostField('companyName', e.target.value)}
                      disabled={!canCreateJobPost}
                    />
                  </label>
                </div>
                <label>
                  <span>Salary Range</span>
                  <input
                    type="text"
                    placeholder="e.g. $40,000 - $55,000"
                    value={postForm.salaryRange}
                    onChange={(e) => updatePostField('salaryRange', e.target.value)}
                    disabled={!canCreateJobPost}
                  />
                </label>
                <label>
                  <span>Application Deadline</span>
                  <input
                    type="datetime-local"
                    value={postForm.expiresAt}
                    onChange={(e) => updatePostField('expiresAt', e.target.value)}
                    disabled={!canCreateJobPost}
                  />
                </label>
              </div>

              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Description</p>
                  <h4>Role Expectations</h4>
                </div>
                <label>
                  <span>Job Description</span>
                  <textarea
                    rows={4}
                    placeholder="Describe responsibilities, required skills, and expectations"
                    value={postForm.jobDescription}
                    onChange={(e) => updatePostField('jobDescription', e.target.value)}
                    disabled={!canCreateJobPost}
                  />
                </label>
              </div>

              <div className="job-composer-footer">
                <button
                  className="btn btn-soft"
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  disabled={submittingPost}
                >
                  Cancel
                </button>
                <button className="btn btn-primary-solid" type="submit" disabled={submittingPost || !canCreateJobPost}>
                  {submittingPost ? 'Posting...' : 'Post Job'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      <section className="panel feed-panel job-feed-panel">
        <div className="panel-header feed-header">
          <div>
            <p className="eyebrow">Explore</p>
            <h3>Open Job Listings</h3>
          </div>
          <div className="header-actions">
            <span className="pill">{loadingFeed ? 'Refreshing...' : `${filteredFeedItems.length} post(s)`}</span>
            <button className="btn btn-soft" type="button" onClick={refreshFeed}>Refresh</button>
          </div>
        </div>

        <form className="feed-filters job-feed-filters" onSubmit={(e) => e.preventDefault()}>
          <label>
            <span>Search Jobs</span>
            <input
              type="search"
              placeholder="Search by title, company, description, or salary"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </label>
        </form>

        {feedError && (
          <div className="inline-alert" role="alert">
            <p>{feedError}</p>
          </div>
        )}

        {loadingFeed ? (
          <div className="skeleton-grid" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, index) => (
              <div className="feed-card skeleton-card" key={index} />
            ))}
          </div>
        ) : filteredFeedItems.length === 0 ? (
          <div className="empty-state">
            <h4>No job posts found</h4>
            <p>Create a job post above, or change your search.</p>
          </div>
        ) : (
          <div className="feed-grid job-feed-grid">
            {filteredFeedItems.map((item, index) => {
              const details = getJobDetailsFromPost(item);
              const isOwner = isPostOwner(item);
              const canViewApplications = isOwner && isAlumni;

              return (
                <article
                  className="feed-card social-post-card job-post-card job-post-card-elevated feed-card-linkable"
                  key={item.id}
                  style={{ '--card-index': index }}
                  role="link"
                  tabIndex={0}
                  onClick={(event) => handleCardNavigation(event, item.id)}
                  onKeyDown={(event) => handleCardKeyNavigation(event, item.id)}
                >
                  <header className="job-card-head">
                    <div className="job-card-title-wrap">
                      <h4>{details.jobTitle}</h4>
                      <p>{details.companyName}</p>
                    </div>
                    <div className="post-card-header-tools">
                      <div className="pill-row">
                        <span className="pill">{formatDate(item.createdAt)}</span>
                        {item.pinned && <span className="pill tone-pin">Pinned</span>}
                      </div>

                      {(isFacultyOrAdmin || isOwner) && (
                        <PostActionsMenu
                          buttonLabel={`Open actions for ${getPostLabel(item)}`}
                          menuLabel={`Post actions for ${getPostLabel(item)}`}
                          actions={[
                            {
                              key: 'pin',
                              label: item.pinned ? 'Unpin' : 'Pin',
                              hidden: !canPinPosts,
                              disabled: actionBusyPostId === item.id || !isAuthenticated,
                              onSelect: () => patchPost(
                                item.id,
                                { pinned: !item.pinned },
                                item.pinned ? 'Job post unpinned.' : 'Job post pinned.',
                              ),
                            },
                            {
                              key: 'edit',
                              label: 'Edit',
                              hidden: !isOwner,
                              disabled: actionBusyPostId === item.id,
                              onSelect: () => setEditingPost(item),
                            },
                            {
                              key: 'archive',
                              label: 'Archive',
                              disabled: actionBusyPostId === item.id || !isAuthenticated || item.status === 'archived',
                              onSelect: () => patchPost(item.id, { archive: true }, 'Job post archived.'),
                            },
                            {
                              key: 'delete',
                              label: 'Delete',
                              tone: 'danger',
                              disabled: actionBusyPostId === item.id || !isAuthenticated,
                              onSelect: () => deletePost(item),
                            },
                          ]}
                        />
                      )}
                    </div>
                  </header>

                  <div className="job-card-meta-row">
                    <span className="pill">Salary: {details.salaryRange}</span>
                    {details.deadline && <span className="pill">Apply by {formatDate(details.deadline)}</span>}
                    {isOwner && <span className="pill tone-ok">Your post</span>}
                  </div>

                  <p className="job-card-description">{details.jobDescription}</p>

                  <div className="feed-card-actions social-actions reddit-action-row job-post-social-actions">
                    <div className="reddit-vote-group" role="group" aria-label={`Voting controls for ${details.jobTitle}`}>
                      <button
                        className={`reddit-action-btn vote-btn ${item.userVote === 'up' ? 'is-active' : ''}`}
                        type="button"
                        aria-label="Upvote"
                        aria-pressed={item.userVote === 'up'}
                        disabled={actionBusyPostId === item.id || item.status === 'archived'}
                        onClick={() => handleVote(item, 'up')}
                      >
                        <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true">
                          <polyline points="6 11 10 7 14 11" />
                          <line x1="10" y1="7" x2="10" y2="14" />
                        </svg>
                        <span className="sr-only">Upvote</span>
                      </button>
                      <span className="reddit-vote-count" aria-live="polite">{formatCompactCount(getBaseVoteScore(item))}</span>
                      <button
                        className={`reddit-action-btn vote-btn ${item.userVote === 'down' ? 'is-active' : ''}`}
                        type="button"
                        aria-label="Downvote"
                        aria-pressed={item.userVote === 'down'}
                        disabled={actionBusyPostId === item.id || item.status === 'archived'}
                        onClick={() => handleVote(item, 'down')}
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
                      aria-label={`Comments ${getCommentCount(item)}`}
                      aria-expanded={openCommentsPostId === item.id}
                      onClick={() => toggleComments(item)}
                    >
                      <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M4.5 4.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3H4.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
                      </svg>
                      <span className="reddit-action-count">{formatCompactCount(getCommentCount(item))}</span>
                      <span className="sr-only">Comments</span>
                    </button>

                  </div>

                  {openCommentsPostId === item.id && (
                    <section className="post-comments-panel" aria-label="Comments section">
                      <div className="post-comments-header">
                        <h5>Comments</h5>
                        <button
                          className="btn btn-soft"
                          type="button"
                          disabled={commentsLoadingPostId === item.id}
                          onClick={() => loadComments(item.id, { openAfterLoad: false })}
                        >
                          {commentsLoadingPostId === item.id ? 'Refreshing...' : 'Refresh'}
                        </button>
                      </div>

                      {commentsLoadingPostId === item.id ? (
                        <p className="post-comments-hint">Loading comments...</p>
                      ) : Array.isArray(commentsByPostId[item.id]) && commentsByPostId[item.id].length > 0 ? (
                        <ul className="post-comments-list" aria-label="Post comments">
                          {commentsByPostId[item.id].map((comment) => (
                            <li key={comment.id} className="post-comment-item">
                              <div className="post-comment-head">
                                {comment.authorId ? (
                                  <button
                                    type="button"
                                    className="author-inline-btn"
                                    onClick={(event) => navigateToProfile(event, comment.authorId)}
                                  >
                                    {comment.author?.fullName || comment.author?.email || `User ${String(comment.authorId || '').slice(0, 8)}`}
                                  </button>
                                ) : (
                                  <strong>{comment.author?.fullName || comment.author?.email || `User ${String(comment.authorId || '').slice(0, 8)}`}</strong>
                                )}
                                <small>{formatDate(comment.createdAt)}</small>
                              </div>
                              <p>{comment.content}</p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="post-comments-hint">No comments yet. Start the discussion.</p>
                      )}

                      <form
                        className="post-comment-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          submitComment(item.id);
                        }}
                      >
                        <textarea
                          rows={2}
                          placeholder={isAuthenticated ? 'Write a comment...' : 'Sign in to write a comment'}
                          value={commentDrafts[item.id] || ''}
                          onChange={(event) => setCommentDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))}
                          disabled={commentsSubmittingPostId === item.id || !isAuthenticated}
                        />
                        <div className="post-comment-form-actions">
                          <button
                            className="btn btn-primary-solid"
                            type="submit"
                            disabled={commentsSubmittingPostId === item.id || !isAuthenticated || !(commentDrafts[item.id] || '').trim()}
                          >
                            {commentsSubmittingPostId === item.id ? 'Posting...' : 'Post Comment'}
                          </button>
                        </div>
                      </form>
                    </section>
                  )}

                  <footer className="feed-card-actions social-actions job-card-actions">
                    {!isOwner && (
                      isAuthenticated ? (
                        <Link
                          className="btn btn-primary-solid"
                          to={`/job-portal/${item.id}/apply`}
                          state={{
                            fromJobPortal: true,
                            postId: item.id,
                            jobTitle: details.jobTitle,
                            companyName: details.companyName,
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
                        to={`/job-portal/${item.id}/applications`}
                        state={{ fromViewApplications: true, postId: item.id }}
                      >
                        View Applications
                      </Link>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <PostEditModal
        open={Boolean(editingPost)}
        post={editingPost}
        onClose={() => setEditingPost(null)}
        onSaved={handleEditedPostSaved}
        onFeedback={setBanner}
      />
    </div>
  );
}
