import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import PostActionsMenu from '../components/posts/PostActionsMenu';
import PostEditModal from '../components/posts/PostEditModal';
import { getPostAuthorDisplayName } from '../utils/postAuthor';
import { getPostLabel, isFacultyUser } from '../utils/postManagement';
import { openUserProfile } from '../utils/profileNavigation';
import { apiRequest } from '../utils/profileApi';
import EventMetadataBlock from '../components/posts/EventMetadataBlock';
import VolunteerEnrollmentModal from '../components/posts/VolunteerEnrollmentModal';
import {
  buildVolunteerEnrollmentInitialValues,
  isEventOver,
  isVolunteerEligibleEvent,
} from '../utils/eventPost';

const EVENT_TYPES = ['EVENT', 'EVENT_RECAP'];
const FEED_LIMIT = 60;
const CARD_NAV_IGNORE_SELECTOR = 'a,button,input,textarea,select,label,[role="button"],.post-comments-panel,[data-prevent-card-nav="true"]';
const compactCountFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const initialFilters = {
  type: '',
  tag: '',
  status: 'published',
  sort: 'new',
};

const initialComposerForm = {
  type: 'EVENT',
  title: '',
  summary: '',
  startsAt: '',
  endsAt: '',
  location: '',
  rules: '',
  contactInfo: '',
  rsvpUrl: '',
  organizerNotes: '',
};

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isEventType(value) {
  return EVENT_TYPES.includes(String(value || '').toUpperCase());
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

function statusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'published') return 'ok';
  if (normalized === 'archived') return 'muted';
  if (normalized === 'draft') return 'warn';
  return 'neutral';
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

function getCreatedAtTime(post) {
  const timestamp = Number(new Date(post?.createdAt || 0));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortPosts(posts, sort = 'new') {
  const normalizedSort = String(sort || '').toLowerCase() === 'upvotes' ? 'upvotes' : 'new';
  return posts.slice().sort((a, b) => {
    if (normalizedSort === 'upvotes') {
      const voteDelta = getBaseVoteScore(b) - getBaseVoteScore(a);
      if (voteDelta !== 0) return voteDelta;
    }
    const timeDelta = getCreatedAtTime(b) - getCreatedAtTime(a);
    if (timeDelta !== 0) return timeDelta;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  });
}

function buildFeedParams({ type, filters, search }) {
  const params = new URLSearchParams();
  params.set('type', type);
  params.set('limit', String(FEED_LIMIT));
  params.set('offset', '0');
  params.set('sort', filters.sort || 'new');

  const normalizedStatus = normalizeText(filters.status).toLowerCase();
  if (normalizedStatus && normalizedStatus !== 'all') {
    params.set('status', normalizedStatus);
  } else if (normalizedStatus === 'all') {
    params.set('status', 'all');
    params.set('includeArchived', 'true');
  }
  if (normalizedStatus === 'archived') {
    params.set('includeArchived', 'true');
  }

  if (filters.tag) params.set('tag', String(filters.tag));
  if (search) params.set('search', search);
  return params;
}

export default function EventsPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isModerator, user } = useAuth();
  const canPinPosts = isFacultyUser(user);
  const currentUserId = String(user?.id || '').trim();

  const [feedItems, setFeedItems] = useState([]);
  const [tags, setTags] = useState([]);
  const [filters, setFilters] = useState(initialFilters);
  const [searchInput, setSearchInput] = useState('');
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [submittingPost, setSubmittingPost] = useState(false);
  const [feedError, setFeedError] = useState('');
  const [banner, setBanner] = useState({ type: 'idle', message: '' });
  const [refreshTick, setRefreshTick] = useState(0);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [composerForm, setComposerForm] = useState(initialComposerForm);
  const [actionBusyPostId, setActionBusyPostId] = useState(null);
  const [sharingPostId, setSharingPostId] = useState(null);
  const [enrollingPostId, setEnrollingPostId] = useState(null);
  const [volunteerModalPost, setVolunteerModalPost] = useState(null);
  const [openCommentsPostId, setOpenCommentsPostId] = useState(null);
  const [commentsByPostId, setCommentsByPostId] = useState({});
  const [commentsLoadingPostId, setCommentsLoadingPostId] = useState(null);
  const [commentsSubmittingPostId, setCommentsSubmittingPostId] = useState(null);
  const [commentDrafts, setCommentDrafts] = useState({});
  const [editingPost, setEditingPost] = useState(null);

  const deferredSearch = useDeferredValue(searchInput);
  const activeSearch = deferredSearch.trim();

  const eventStats = useMemo(() => {
    const recapCount = feedItems.filter((item) => String(item?.type || '').toUpperCase() === 'EVENT_RECAP').length;
    return {
      total: feedItems.length,
      recaps: recapCount,
      events: feedItems.length - recapCount,
    };
  }, [feedItems]);

  useEffect(() => {
    let isMounted = true;

    async function loadTags() {
      try {
        const result = await apiRequest('/posts/tags');
        if (!isMounted) return;
        startTransition(() => {
          setTags(Array.isArray(result?.data) ? result.data : []);
        });
      } catch (error) {
        if (!isMounted) return;
        setBanner({ type: 'error', message: `Failed to load tags: ${error.message}` });
      }
    }

    loadTags();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function fetchByType(type) {
      const params = buildFeedParams({ type, filters, search: activeSearch });
      const result = await apiRequest(`/posts/feed?${params.toString()}`, { signal: controller.signal });
      return Array.isArray(result?.data)
        ? result.data.filter((item) => String(item?.type || '').toUpperCase() === type)
        : [];
    }

    async function loadFeed() {
      setLoadingFeed(true);
      setFeedError('');
      try {
        const normalizedType = String(filters.type || '').toUpperCase();
        const requestedTypes = isEventType(normalizedType) ? [normalizedType] : EVENT_TYPES;
        const parts = await Promise.all(requestedTypes.map((type) => fetchByType(type)));
        if (!isMounted) return;

        const merged = [];
        const seen = new Set();
        for (const list of parts) {
          for (const item of list) {
            const id = String(item?.id || '').trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            merged.push(item);
          }
        }

        startTransition(() => {
          setFeedItems(sortPosts(merged, filters.sort).slice(0, FEED_LIMIT));
        });
      } catch (error) {
        if (!isMounted || error.name === 'AbortError') return;
        setFeedError(error.message || 'Could not load event posts.');
        setFeedItems([]);
      } finally {
        if (isMounted) setLoadingFeed(false);
      }
    }

    loadFeed();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [filters, activeSearch, refreshTick]);

  useEffect(() => {
    if (!isCreateModalOpen) return undefined;
    function onEscape(event) {
      if (event.key !== 'Escape' || submittingPost) return;
      setIsCreateModalOpen(false);
    }
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [isCreateModalOpen, submittingPost]);

  function refreshFeed() {
    setRefreshTick((prev) => prev + 1);
  }

  function updateFilter(field, value) {
    setFilters((prev) => ({ ...prev, [field]: value }));
  }

  function clearFilters() {
    setFilters(initialFilters);
    setSearchInput('');
  }

  function updateComposerField(field, value) {
    setComposerForm((prev) => ({ ...prev, [field]: value }));
  }

  function updatePostEngagement(postId, patch) {
    setFeedItems((prev) => prev.map((item) => (item.id === postId ? { ...item, ...patch } : item)));
  }

  function handleEditedPostSaved(updatedPost) {
    if (!updatedPost?.id) return;
    setFeedItems((prev) => prev.map((item) => (
      item.id === updatedPost.id
        ? { ...item, ...updatedPost }
        : item
    )));
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

  function isPostOwner(post) {
    if (!post?.authorId || !user?.id) return false;
    return String(post.authorId) === String(user.id);
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
      if (openAfterLoad) setOpenCommentsPostId(postId);
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
    const content = (commentDrafts[postId] || '').trim();
    if (!content) return;
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to comment on event posts.' });
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
      }
    } catch (error) {
      setBanner({ type: 'error', message: `Comment failed: ${error.message}` });
    } finally {
      setCommentsSubmittingPostId(null);
    }
  }

  async function handleVote(post, direction) {
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to vote on event posts.' });
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
      setBanner({ type: 'error', message: `Vote failed: ${error.message}` });
    } finally {
      setActionBusyPostId(null);
    }
  }

  async function handleShare(postId) {
    if (!postId) return;
    setSharingPostId(postId);
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
      setSharingPostId(null);
    }
  }

  async function handleArchivePost(post) {
    if (!post?.id) return;
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to update posts.' });
      return;
    }

    setActionBusyPostId(post.id);
    try {
      await apiRequest(`/posts/posts/${post.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ archive: true }),
      });
      updatePostEngagement(post.id, { status: 'archived' });
      setBanner({ type: 'success', message: 'Event post archived.' });
    } catch (error) {
      setBanner({ type: 'error', message: `Post update failed: ${error.message}` });
    } finally {
      setActionBusyPostId(null);
    }
  }

  async function handleDeletePost(post) {
    if (!post?.id) return;
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to delete posts.' });
      return;
    }

    const confirmed = window.confirm(`Delete "${getPostLabel(post)}" permanently?`);
    if (!confirmed) return;

    setActionBusyPostId(post.id);
    try {
      await apiRequest(`/posts/posts/${post.id}`, { method: 'DELETE' });
      setFeedItems((prev) => prev.filter((item) => item.id !== post.id));
      setCommentsByPostId((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, post.id)) return prev;
        const next = { ...prev };
        delete next[post.id];
        return next;
      });
      if (openCommentsPostId === post.id) setOpenCommentsPostId(null);
      setBanner({ type: 'success', message: 'Event post deleted.' });
    } catch (error) {
      setBanner({ type: 'error', message: `Post delete failed: ${error.message}` });
    } finally {
      setActionBusyPostId(null);
    }
  }

  async function handleTogglePinned(post) {
    if (!post?.id) return;
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to update posts.' });
      return;
    }
    if (!canPinPosts) {
      setBanner({ type: 'error', message: 'Only faculty accounts can pin posts.' });
      return;
    }

    const nextPinned = !Boolean(post?.pinned);
    setActionBusyPostId(post.id);
    try {
      await apiRequest(`/posts/posts/${post.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned: nextPinned }),
      });
      updatePostEngagement(post.id, { pinned: nextPinned });
      setBanner({ type: 'success', message: nextPinned ? 'Event post pinned.' : 'Event post unpinned.' });
    } catch (error) {
      setBanner({ type: 'error', message: `Post update failed: ${error.message}` });
    } finally {
      setActionBusyPostId(null);
    }
  }

  function openVolunteerEnrollment(post) {
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to enroll as a volunteer.' });
      return;
    }
    if (!post?.id) return;
    if (!isVolunteerEligibleEvent(post)) {
      setBanner({ type: 'error', message: 'Volunteer enrollment is only available for active EVENT posts.' });
      return;
    }
    if (String(post.authorId || '') === currentUserId) {
      setBanner({ type: 'error', message: 'Event creators cannot enroll themselves as volunteers.' });
      return;
    }
    if (post.viewerHasVolunteerEnrollment) {
      setBanner({ type: 'success', message: 'You have already enrolled as a volunteer for this event.' });
      return;
    }
    if (isEventOver(post)) {
      setBanner({ type: 'error', message: 'This event has already ended.' });
      return;
    }
    setVolunteerModalPost(post);
  }

  async function submitVolunteerEnrollment(formValues) {
    const postId = volunteerModalPost?.id;
    if (!postId) return;

    setEnrollingPostId(postId);
    try {
      const result = await apiRequest(`/posts/posts/${postId}/volunteers`, {
        method: 'POST',
        body: JSON.stringify(formValues),
      });
      const backendCount = Number(result?.meta?.volunteerCount);
      updatePostEngagement(postId, {
        volunteerCount: Number.isFinite(backendCount)
          ? Math.max(0, Math.trunc(backendCount))
          : Math.max(0, Math.trunc(Number(volunteerModalPost?.volunteerCount || 0))) + 1,
        viewerHasVolunteerEnrollment: true,
      });
      setVolunteerModalPost(null);
      setBanner({ type: 'success', message: 'Volunteer enrollment submitted. The event creator has been notified.' });
    } catch (error) {
      setBanner({ type: 'error', message: `Could not enroll as volunteer: ${error.message}` });
    } finally {
      setEnrollingPostId(null);
    }
  }

  async function handleCreatePost(event) {
    event.preventDefault();
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to create event posts.' });
      return;
    }

    const type = String(composerForm.type || '').toUpperCase();
    if (!isEventType(type)) {
      setBanner({ type: 'error', message: 'Choose EVENT or EVENT_RECAP.' });
      return;
    }

    const title = normalizeText(composerForm.title);
    const summary = normalizeText(composerForm.summary);
    const location = normalizeText(composerForm.location);
    const rules = normalizeText(composerForm.rules);
    const contactInfo = normalizeText(composerForm.contactInfo);
    const rsvpUrl = normalizeText(composerForm.rsvpUrl);
    const organizerNotes = normalizeText(composerForm.organizerNotes);
    if (!title || !summary) {
      setBanner({ type: 'error', message: 'Title and summary are required.' });
      return;
    }

    let startsAt = null;
    const startsAtInput = normalizeText(composerForm.startsAt);
    if (startsAtInput) {
      const parsed = new Date(startsAtInput);
      if (Number.isNaN(parsed.getTime())) {
        setBanner({ type: 'error', message: 'Start date/time is invalid.' });
        return;
      }
      startsAt = parsed.toISOString();
    }

    let endsAt = null;
    const endsAtInput = normalizeText(composerForm.endsAt);
    if (endsAtInput) {
      const parsed = new Date(endsAtInput);
      if (Number.isNaN(parsed.getTime())) {
        setBanner({ type: 'error', message: 'End date/time is invalid.' });
        return;
      }
      endsAt = parsed.toISOString();
    }

    const maybeAuthorId = user?.id && /^[0-9a-fA-F-]{32,36}$/.test(String(user.id))
      ? user.id
      : undefined;
    const refEntityId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `event-details-${Date.now()}`;

    const payload = {
      type,
      title,
      summary,
      status: 'published',
      ref: {
        service: 'event-details',
        entityId: refEntityId,
        metadata: {
          startsAt,
          endsAt,
          location: location || null,
          venue: location || null,
          rules: rules || null,
          contactInfo: contactInfo || null,
          rsvpUrl: rsvpUrl || null,
          organizerNotes: organizerNotes || null,
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
      setComposerForm(initialComposerForm);
      setBanner({ type: 'success', message: 'Event post published.' });
      setIsCreateModalOpen(false);
      refreshFeed();
    } catch (error) {
      setBanner({ type: 'error', message: `Could not create event post: ${error.message}` });
    } finally {
      setSubmittingPost(false);
    }
  }

  return (
    <div className="home-feed-page collab-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      <section className="panel collab-overview-panel">
        <div className="collab-overview-head">
          <div>
            <p className="eyebrow">Events</p>
            <h2>Events and Event Recaps</h2>
            <p>Browse event posts with full interactions and volunteer enrollment.</p>
          </div>
          <div className="collab-overview-stats">
            <div className="collab-overview-stat-card">
              <span>Visible cards</span>
              <strong>{eventStats.total}</strong>
            </div>
            <div className="collab-overview-stat-card">
              <span>Events</span>
              <strong>{eventStats.events}</strong>
            </div>
            <div className="collab-overview-stat-card">
              <span>Recaps</span>
              <strong>{eventStats.recaps}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="collab-top-grid">
        <section className="panel composer-panel collab-composer-panel collab-composer-compact">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Create</p>
              <h3>Publish an Event or Recap</h3>
            </div>
            <span className="pill pill-ghost">POST /posts/posts</span>
          </div>
          <p className="collab-mini-summary">Open the popup for event creation fields.</p>
          <div className="feed-card-actions collab-create-actions">
            <button className="btn btn-primary-solid" type="button" onClick={() => setIsCreateModalOpen(true)}>
              Open Event Form
            </button>
          </div>
          {!isAuthenticated && (
            <div className="inline-alert warn-alert">
              <p>
                Guest mode is active. You can browse events, but publishing requires authentication.
                <Link to="/login"> Sign in</Link> or <Link to="/signup"> create an account</Link>.
              </p>
            </div>
          )}
        </section>
      </section>

      {isCreateModalOpen && (
        <div
          className="profile-edit-backdrop collab-create-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Create event post"
          onClick={() => {
            if (submittingPost) return;
            setIsCreateModalOpen(false);
          }}
        >
          <section className="panel profile-edit-modal collab-create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Create</p>
                <h3>New Event Post</h3>
              </div>
              <button type="button" className="btn btn-soft" onClick={() => setIsCreateModalOpen(false)} disabled={submittingPost}>
                Close
              </button>
            </div>

            <form className="stacked-form collab-create-form" onSubmit={handleCreatePost}>
              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Core Information</p>
                  <h4>Post Basics</h4>
                </div>

                <div className="field-row two-col">
                  <label>
                    <span>Type <strong className="required-marker">*</strong></span>
                    <select value={composerForm.type} onChange={(event) => updateComposerField('type', event.target.value)}>
                      <option value="EVENT">EVENT</option>
                      <option value="EVENT_RECAP">EVENT_RECAP</option>
                    </select>
                  </label>

                  <label>
                    <span>Location (optional)</span>
                    <input type="text" value={composerForm.location} onChange={(event) => updateComposerField('location', event.target.value)} />
                  </label>
                </div>

                <label>
                  <span>Title <strong className="required-marker">*</strong></span>
                  <input type="text" value={composerForm.title} onChange={(event) => updateComposerField('title', event.target.value)} />
                </label>

                <label>
                  <span>Summary <strong className="required-marker">*</strong></span>
                  <textarea rows={4} value={composerForm.summary} onChange={(event) => updateComposerField('summary', event.target.value)} />
                </label>
              </div>

              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Schedule</p>
                  <h4>Date and Time</h4>
                </div>
                <div className="field-row two-col">
                  <label>
                    <span>Starts At (optional)</span>
                    <input type="datetime-local" value={composerForm.startsAt} onChange={(event) => updateComposerField('startsAt', event.target.value)} />
                  </label>
                  <label>
                    <span>Ends At (optional)</span>
                    <input type="datetime-local" value={composerForm.endsAt} onChange={(event) => updateComposerField('endsAt', event.target.value)} />
                  </label>
                </div>
              </div>

              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Extras</p>
                  <h4>Volunteer and Attendance Details</h4>
                </div>

                <div className="field-row two-col">
                  <label>
                    <span>Contact Info</span>
                    <input type="text" value={composerForm.contactInfo} onChange={(event) => updateComposerField('contactInfo', event.target.value)} />
                  </label>
                  <label>
                    <span>RSVP Link</span>
                    <input type="url" value={composerForm.rsvpUrl} onChange={(event) => updateComposerField('rsvpUrl', event.target.value)} />
                  </label>
                </div>

                <label>
                  <span>Rules or Guidelines</span>
                  <textarea rows={3} value={composerForm.rules} onChange={(event) => updateComposerField('rules', event.target.value)} />
                </label>

                <label>
                  <span>Organizer Notes</span>
                  <textarea rows={3} value={composerForm.organizerNotes} onChange={(event) => updateComposerField('organizerNotes', event.target.value)} />
                </label>
              </div>

              <div className="feed-card-actions collab-create-actions">
                <button className="btn btn-soft" type="button" onClick={() => setIsCreateModalOpen(false)} disabled={submittingPost}>Cancel</button>
                <button className="btn btn-primary-solid" type="submit" disabled={!isAuthenticated || submittingPost}>
                  {submittingPost ? 'Publishing...' : 'Publish Event Post'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {volunteerModalPost && (
        <VolunteerEnrollmentModal
          open={Boolean(volunteerModalPost)}
          post={volunteerModalPost}
          submitting={Boolean(volunteerModalPost?.id) && enrollingPostId === volunteerModalPost?.id}
          initialValues={buildVolunteerEnrollmentInitialValues(user)}
          onClose={() => {
            if (enrollingPostId) return;
            setVolunteerModalPost(null);
          }}
          onSubmit={submitVolunteerEnrollment}
        />
      )}

      <PostEditModal
        open={Boolean(editingPost)}
        post={editingPost}
        onClose={() => setEditingPost(null)}
        onSaved={handleEditedPostSaved}
        onFeedback={setBanner}
      />

      <section className="panel feed-panel collab-feed-panel">
        <div className="panel-header feed-header">
          <div>
            <p className="eyebrow">Discover</p>
            <h3>Events Feed</h3>
          </div>
          <div className="header-actions">
            <span className="pill">{loadingFeed ? 'Loading...' : `${feedItems.length} card(s)`}</span>
            <button className="btn btn-soft" type="button" onClick={refreshFeed}>Refresh</button>
          </div>
        </div>

        <form className="feed-filters collab-feed-filters" onSubmit={(event) => event.preventDefault()}>
          <label>
            <span>Search</span>
            <input type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
          </label>
          <label>
            <span>Type</span>
            <select value={filters.type} onChange={(event) => updateFilter('type', event.target.value)}>
              <option value="">All Event Types</option>
              <option value="EVENT">EVENT</option>
              <option value="EVENT_RECAP">EVENT_RECAP</option>
            </select>
          </label>
          <label>
            <span>Tag</span>
            <select value={filters.tag} onChange={(event) => updateFilter('tag', event.target.value)}>
              <option value="">All tags</option>
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
              <option value="all">All statuses</option>
            </select>
          </label>
          <label>
            <span>Sort By</span>
            <select value={filters.sort} onChange={(event) => updateFilter('sort', event.target.value)}>
              <option value="new">Newest</option>
              <option value="upvotes">Most upvoted</option>
            </select>
          </label>
          <div className="collab-filter-actions">
            <button className="btn btn-soft" type="button" onClick={clearFilters}>Reset</button>
          </div>
        </form>

        {feedError && (
          <div className="inline-alert" role="alert">
            <p>{feedError}</p>
          </div>
        )}

        {loadingFeed ? (
          <div className="skeleton-grid" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="feed-card skeleton-card" key={`events-skeleton-${index}`} />
            ))}
          </div>
        ) : feedItems.length === 0 ? (
          <div className="empty-state">
            <h4>No event posts match the current filters</h4>
            <p>Try adjusting filters or publish a new event from the composer above.</p>
          </div>
        ) : (
          <div className="feed-grid">
            {feedItems.map((item, index) => {
              const authorLabel = getPostAuthorDisplayName(item, 'Community member');
              const authorId = item?.author?.id || item?.authorId || null;
              const isOwner = isPostOwner(item);
              const canVolunteer = isVolunteerEligibleEvent(item) && !isOwner;
              const alreadyEnrolled = Boolean(item?.viewerHasVolunteerEnrollment);
              const eventEnded = isEventOver(item);
              const volunteerCount = Number.isFinite(Number(item?.volunteerCount))
                ? Math.max(0, Math.trunc(Number(item.volunteerCount)))
                : 0;

              return (
                <article
                  className="feed-card social-post-card feed-card-linkable is-event-post"
                  key={item.id}
                  style={{ '--card-index': index }}
                  role="link"
                  tabIndex={0}
                  onClick={(event) => {
                    if (!shouldIgnoreCardNavigation(event.target)) openPostDetails(item.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    if (shouldIgnoreCardNavigation(event.target)) return;
                    event.preventDefault();
                    openPostDetails(item.id);
                  }}
                >
                  <div className="social-post-header">
                    <div className="post-author-chip">
                      <span className="post-avatar">{(item.type || 'P').slice(0, 1)}</span>
                      <div>
                        <strong>{item.title || `${item.type} update`}</strong>
                        <small>{formatDate(item.createdAt)}</small>
                      </div>
                    </div>
                    <div className="post-card-header-tools">
                      <div className="pill-row">
                        <span className={`pill tone-${statusTone(item.status)}`}>{item.status || 'unknown'}</span>
                        {item.pinned && <span className="pill tone-pin">Pinned</span>}
                      </div>

                      {(isModerator || isOwner) && (
                        <PostActionsMenu
                          buttonLabel={`Open actions for ${getPostLabel(item)}`}
                          menuLabel={`Post actions for ${getPostLabel(item)}`}
                          actions={[
                            {
                              key: 'pin',
                              label: item.pinned ? 'Unpin' : 'Pin',
                              hidden: !canPinPosts,
                              disabled: actionBusyPostId === item.id || !isAuthenticated,
                              onSelect: () => handleTogglePinned(item),
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
                              onSelect: () => handleArchivePost(item),
                            },
                            {
                              key: 'delete',
                              label: 'Delete',
                              tone: 'danger',
                              disabled: actionBusyPostId === item.id || !isAuthenticated,
                              onSelect: () => handleDeletePost(item),
                            },
                          ]}
                        />
                      )}
                    </div>
                  </div>

                  <p className="feed-summary">{item.summary || 'No summary provided.'}</p>
                  <EventMetadataBlock post={item} variant="card" />

                  <div className="post-utility-bar">
                    <span className="pill">{item.type || 'UNKNOWN'}</span>
                    {isVolunteerEligibleEvent(item) && <span className="pill">Volunteers {volunteerCount}</span>}
                    {authorId ? (
                      <button type="button" className="pill author-nav-pill" onClick={(event) => navigateToProfile(event, authorId)}>
                        {authorLabel}
                      </button>
                    ) : (
                      <span className="pill">{authorLabel}</span>
                    )}
                  </div>

                  <div className="feed-card-actions social-actions reddit-action-row">
                    <div className="reddit-vote-group" role="group" aria-label={`Voting controls for ${item.title || 'post'}`}>
                      <button className={`reddit-action-btn vote-btn ${item.userVote === 'up' ? 'is-active' : ''}`} type="button" disabled={actionBusyPostId === item.id || item.status === 'archived'} onClick={() => handleVote(item, 'up')}>
                        <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true"><polyline points="6 11 10 7 14 11" /><line x1="10" y1="7" x2="10" y2="14" /></svg>
                        <span className="sr-only">Upvote</span>
                      </button>
                      <span className="reddit-vote-count">{formatCompactCount(getBaseVoteScore(item))}</span>
                      <button className={`reddit-action-btn vote-btn ${item.userVote === 'down' ? 'is-active' : ''}`} type="button" disabled={actionBusyPostId === item.id || item.status === 'archived'} onClick={() => handleVote(item, 'down')}>
                        <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true"><polyline points="6 9 10 13 14 9" /><line x1="10" y1="6" x2="10" y2="13" /></svg>
                        <span className="sr-only">Downvote</span>
                      </button>
                    </div>

                    <button className="reddit-action-btn reddit-metric-btn" type="button" onClick={() => toggleComments(item)}>
                      <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 4.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3H4.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" /></svg>
                      <span className="reddit-action-count">{formatCompactCount(getCommentCount(item))}</span>
                    </button>

                    <button className="reddit-action-btn reddit-metric-btn reddit-share-btn" type="button" onClick={() => handleShare(item.id)} disabled={sharingPostId === item.id}>
                      <svg className="reddit-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M12 5 16 9 12 13" /><path d="M16 9H8a4 4 0 0 0-4 4" /></svg>
                      <span>{sharingPostId === item.id ? 'Sharing...' : 'Share'}</span>
                    </button>

                    {canVolunteer && (
                      <button
                        className="reddit-action-btn reddit-metric-btn event-volunteer-btn"
                        type="button"
                        onClick={() => openVolunteerEnrollment(item)}
                        disabled={enrollingPostId === item.id || alreadyEnrolled || item.status === 'archived' || eventEnded}
                      >
                        {alreadyEnrolled
                          ? 'Already Enrolled'
                          : eventEnded
                            ? 'Event Ended'
                            : enrollingPostId === item.id
                              ? 'Submitting...'
                              : 'Enroll as Volunteer'}
                      </button>
                    )}
                  </div>

                  {openCommentsPostId === item.id && (
                    <section className="post-comments-panel" aria-label="Comments section">
                      <div className="post-comments-header">
                        <h5>Comments</h5>
                        <button className="btn btn-soft" type="button" onClick={() => loadComments(item.id, { openAfterLoad: false })}>
                          {commentsLoadingPostId === item.id ? 'Refreshing...' : 'Refresh'}
                        </button>
                      </div>

                      {commentsLoadingPostId === item.id ? (
                        <p className="post-comments-hint">Loading comments...</p>
                      ) : Array.isArray(commentsByPostId[item.id]) && commentsByPostId[item.id].length > 0 ? (
                        <ul className="post-comments-list">
                          {commentsByPostId[item.id].map((comment) => (
                            <li key={comment.id} className="post-comment-item">
                              <div className="post-comment-head">
                                <strong>{comment.author?.fullName || comment.author?.email || `User ${String(comment.authorId || '').slice(0, 8)}`}</strong>
                                <small>{formatDate(comment.createdAt)}</small>
                              </div>
                              <p>{comment.content}</p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="post-comments-hint">No comments yet. Start the discussion.</p>
                      )}

                      <form className="post-comment-form" onSubmit={(event) => {
                        event.preventDefault();
                        submitComment(item.id);
                      }}>
                        <textarea rows={2} placeholder={isAuthenticated ? 'Write a comment...' : 'Sign in to write a comment'} value={commentDrafts[item.id] || ''} onChange={(event) => setCommentDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))} disabled={commentsSubmittingPostId === item.id || !isAuthenticated} />
                        <div className="post-comment-form-actions">
                          <button className="btn btn-primary-solid" type="submit" disabled={commentsSubmittingPostId === item.id || !isAuthenticated || !(commentDrafts[item.id] || '').trim()}>
                            {commentsSubmittingPostId === item.id ? 'Posting...' : 'Post Comment'}
                          </button>
                        </div>
                      </form>
                    </section>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
