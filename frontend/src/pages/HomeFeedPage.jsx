import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import PostActionsMenu from '../components/posts/PostActionsMenu';
import { getPostAuthorDisplayName } from '../utils/postAuthor';
import { openUserProfile } from '../utils/profileNavigation';
import { getPostLabel } from '../utils/postManagement';
import { getPostTypeIconKey, getPostTypeIconPaths } from '../utils/postTypeIcon';
import EventMetadataBlock from '../components/posts/EventMetadataBlock';
import VolunteerEnrollmentModal from '../components/posts/VolunteerEnrollmentModal';
import {
  buildVolunteerEnrollmentInitialValues,
  isEventOver,
  isEventPostType,
  isVolunteerEligibleEvent,
} from '../utils/eventPost';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

const initialPostForm = {
  type: 'EVENT',
  title: '',
  summary: '',
  status: 'published',
  tagIds: [],
  pinned: false,
  expiresAt: '',
};

const postTypeOptions = [
  { value: 'ANNOUNCEMENT', label: 'Announcement' },
  { value: 'JOB', label: 'Job' },
  { value: 'EVENT', label: 'Event' },
  { value: 'EVENT_RECAP', label: 'Event Recap' },
  { value: 'ACHIEVEMENT', label: 'Achievement' },
  { value: 'COLLAB', label: 'Collaboration' },
];

function canRoleCreateType(role, type) {
  const normalizedRole = String(role || '').toLowerCase();
  const normalizedType = String(type || '').toUpperCase();

  if (normalizedType === 'ANNOUNCEMENT') return normalizedRole === 'admin' || normalizedRole === 'faculty';
  if (normalizedType === 'JOB') return normalizedRole !== 'student';
  return true;
}

function getRoleTypeBlockMessage(role, type) {
  const normalizedRole = String(role || '').toLowerCase();
  const normalizedType = String(type || '').toUpperCase();
  if (normalizedType === 'ANNOUNCEMENT') {
    return normalizedRole === 'alumni'
      ? 'Alumni cannot create announcement posts.'
      : 'Students cannot create announcement posts.';
  }
  if (normalizedType === 'JOB') {
    return 'Students cannot create job posts.';
  }
  return 'You are not allowed to create this post type.';
}

const initialFilters = {
  type: '',
  status: 'published',
  tag: '',
  pinnedOnly: false,
};
const FEED_PAGE_LIMIT = 10;
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

function statusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'published') return 'ok';
  if (normalized === 'archived') return 'muted';
  if (normalized === 'draft') return 'warn';
  return 'neutral';
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

function getPostImageUrl(post) {
  if (!Array.isArray(post?.refs)) return '';
  const imageRef = post.refs.find((ref) => (
    ref?.service === 'image-upload'
    && typeof ref?.metadata?.imageDataUrl === 'string'
    && ref.metadata.imageDataUrl.trim()
  ));
  return imageRef?.metadata?.imageDataUrl?.trim() || '';
}

export default function HomeFeedPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isModerator, user } = useAuth();
  const imageInputRef = useRef(null);
  const [feedItems, setFeedItems] = useState([]);
  const [tags, setTags] = useState([]);
  const [postForm, setPostForm] = useState(initialPostForm);
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState(initialFilters);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [submittingPost, setSubmittingPost] = useState(false);
  const [actionBusyPostId, setActionBusyPostId] = useState(null);
  const [banner, setBanner] = useState({ type: 'idle', message: '' });
  const [feedError, setFeedError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [tagSearchInput, setTagSearchInput] = useState('');
  const [composerImage, setComposerImage] = useState(null);
  const [openCommentsPostId, setOpenCommentsPostId] = useState(null);
  const [commentsByPostId, setCommentsByPostId] = useState({});
  const [commentsLoadingPostId, setCommentsLoadingPostId] = useState(null);
  const [commentsSubmittingPostId, setCommentsSubmittingPostId] = useState(null);
  const [commentDrafts, setCommentDrafts] = useState({});
  const [enrollingPostId, setEnrollingPostId] = useState(null);
  const [volunteerModalPost, setVolunteerModalPost] = useState(null);

  const deferredSearch = useDeferredValue(searchInput);
  const activeSearch = deferredSearch.trim();
  const normalizedRole = String(user?.role || '').toLowerCase();
  const currentUserId = String(user?.id || '').trim();
  const allowedComposerTypeOptions = useMemo(
    () => postTypeOptions.filter((option) => canRoleCreateType(normalizedRole, option.value)),
    [normalizedRole],
  );
  const composerAvatar = String(user?.full_name || user?.name || user?.email || 'G').trim().charAt(0).toUpperCase() || 'G';
  const composerSelectedTagIds = Array.isArray(postForm.tagIds)
    ? postForm.tagIds.map((value) => String(value)).filter(Boolean)
    : [];
  const composerSelectedTagIdSet = new Set(composerSelectedTagIds);
  const selectedComposerTags = tags.filter((tag) => composerSelectedTagIdSet.has(String(tag.id)));
  const normalizedTagQuery = tagSearchInput.trim().toLowerCase();
  const filteredTagResults = tags
    .filter((tag) => {
      if (composerSelectedTagIdSet.has(String(tag.id))) return false;
      if (!normalizedTagQuery) return true;
      const name = String(tag.name || '').toLowerCase();
      const slug = String(tag.slug || '').toLowerCase();
      return name.includes(normalizedTagQuery) || slug.includes(normalizedTagQuery);
    })
    .slice(0, 8);

  useEffect(() => {
    let isMounted = true;

    async function loadTags() {
      try {
        const result = await apiRequest('/posts/tags');
        if (!isMounted) return;
        startTransition(() => {
          setTags(Array.isArray(result.data) ? result.data : []);
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

    async function loadFeed() {
      setLoadingFeed(true);
      setFeedError('');

      const baseParams = new URLSearchParams();
      if (filters.type) baseParams.set('type', filters.type);
      if (filters.status) baseParams.set('status', filters.status);
      if (filters.status === 'archived') baseParams.set('includeArchived', 'true');
      if (filters.tag) baseParams.set('tag', filters.tag);
      if (filters.pinnedOnly) baseParams.set('pinnedOnly', 'true');
      if (activeSearch) baseParams.set('search', activeSearch);

      try {
        const params = new URLSearchParams(baseParams);
        params.set('limit', String(FEED_PAGE_LIMIT));
        params.set('offset', '0');

        const result = await apiRequest(`/posts/feed?${params.toString()}`, {
          signal: controller.signal,
        });
        const items = Array.isArray(result.data) ? result.data : [];

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
  }, [filters, activeSearch, refreshTick]);

  useEffect(() => {
    if (!allowedComposerTypeOptions.some((option) => option.value === postForm.type)) {
      const fallbackType = allowedComposerTypeOptions[0]?.value || 'EVENT';
      setPostForm((prev) => ({ ...prev, type: fallbackType }));
    }
  }, [allowedComposerTypeOptions, postForm.type]);

  function updateFilter(field, value) {
    setFilters((prev) => ({ ...prev, [field]: value }));
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

  function isPostOwner(post) {
    if (!post?.authorId || !user?.id) return false;
    return String(post.authorId) === String(user.id);
  }

  function canUpdatePostExpiry(post) {
    if (!isAuthenticated) return false;
    return isModerator || isPostOwner(post);
  }

  function addTagToComposer(tagId) {
    updatePostField('tagIds', [...new Set([...composerSelectedTagIds, String(tagId)])]);
    setTagSearchInput('');
  }

  function removeTagFromComposer(tagId) {
    updatePostField('tagIds', composerSelectedTagIds.filter((id) => id !== String(tagId)));
  }

  function refreshFeed() {
    setRefreshTick((prev) => prev + 1);
  }

  function openImagePicker() {
    imageInputRef.current?.click();
  }

  function clearComposerImage() {
    setComposerImage(null);
    if (imageInputRef.current) imageInputRef.current.value = '';
  }

  function handleImageSelected(event) {
    const [file] = Array.from(event.target.files || []);
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setBanner({ type: 'error', message: 'Only image files are supported.' });
      return;
    }

    const maxBytes = 900 * 1024;
    if (file.size > maxBytes) {
      setBanner({ type: 'error', message: 'Image is too large. Please choose one under 900 KB.' });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        setBanner({ type: 'error', message: 'Could not read the selected image.' });
        return;
      }

      const entityId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `img-${Date.now()}`;

      setComposerImage({
        dataUrl,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        entityId,
      });
    };
    reader.onerror = () => {
      setBanner({ type: 'error', message: 'Failed to load selected image.' });
    };
    reader.readAsDataURL(file);
  }

  async function handleCreatePost(event) {
    event.preventDefault();
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to create posts.' });
      return;
    }

    if (!postForm.type) {
      setBanner({ type: 'error', message: 'Type is required to create a post.' });
      return;
    }

    if (!canRoleCreateType(normalizedRole, postForm.type)) {
      setBanner({ type: 'error', message: getRoleTypeBlockMessage(normalizedRole, postForm.type) });
      return;
    }

    if (!postForm.summary.trim()) {
      setBanner({ type: 'error', message: 'Summary is required to create a post.' });
      return;
    }

    const maybeAuthorId = user?.id && /^[0-9a-fA-F-]{32,36}$/.test(String(user.id)) ? user.id : undefined;

    const payload = {
      type: postForm.type,
      title: postForm.title.trim() || null,
      summary: postForm.summary.trim(),
      status: postForm.status,
      pinned: postForm.pinned,
      tags: [...new Set(composerSelectedTagIds)],
      expiresAt: postForm.expiresAt || null,
      ...(composerImage ? {
        ref: {
          service: 'image-upload',
          entityId: composerImage.entityId,
          metadata: {
            imageDataUrl: composerImage.dataUrl,
            fileName: composerImage.fileName,
            fileType: composerImage.fileType,
            fileSize: composerImage.fileSize,
          },
        },
      } : {}),
      ...(maybeAuthorId ? { authorId: maybeAuthorId } : {}),
    };

    setSubmittingPost(true);
    try {
      await apiRequest('/posts/posts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setPostForm(initialPostForm);
      setTagSearchInput('');
      clearComposerImage();
      setBanner({ type: 'success', message: 'Post created and added to the feed.' });
      refreshFeed();
    } catch (error) {
      setBanner({ type: 'error', message: `Could not create post: ${error.message}` });
    } finally {
      setSubmittingPost(false);
    }
  }

  async function patchPost(postId, payload, successMessage, options = {}) {
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to update posts.' });
      return;
    }

    if (options.enforceExpiryPermission) {
      const targetPost = options.post || feedItems.find((item) => item.id === postId);
      if (!canUpdatePostExpiry(targetPost)) {
        setBanner({ type: 'error', message: 'Only moderators and the original author can update expiry.' });
        return;
      }
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

    const canDelete = isModerator || isPostOwner(post);
    if (!canDelete) {
      setBanner({ type: 'error', message: 'Only faculty/admin or the original author can delete this post.' });
      return;
    }

    const title = (post?.title || '').trim();
    const label = title || `${toTitleCase(post?.type || 'post')} post`;
    const confirmed = window.confirm(`Delete "${label}" permanently?`);
    if (!confirmed) return;

    setActionBusyPostId(postId);
    try {
      await apiRequest(`/posts/posts/${postId}`, { method: 'DELETE' });
      setBanner({ type: 'success', message: 'Post deleted.' });
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

  function updatePostEngagement(postId, patch) {
    setFeedItems((prev) => prev.map((item) => {
      if (item.id !== postId) return item;
      return { ...item, ...patch };
    }));
  }

  async function handleVote(post, direction) {
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
      setBanner({ type: 'error', message: 'Sign in to comment on posts.' });
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

  function openVolunteerEnrollment(post) {
    if (!isAuthenticated) {
      setBanner({ type: 'error', message: 'Sign in to enroll as a volunteer.' });
      return;
    }
    if (!post?.id || !isVolunteerEligibleEvent(post)) {
      setBanner({ type: 'error', message: 'Volunteer enrollment is only available for EVENT posts.' });
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

  const topPostItems = useMemo(() => (
    feedItems
      .filter((item) => String(item?.status || '').toLowerCase() !== 'archived')
      .slice()
      .sort((a, b) => {
        const voteDelta = getBaseVoteScore(b) - getBaseVoteScore(a);
        if (voteDelta !== 0) return voteDelta;
        const createdAtA = Number(new Date(a?.createdAt || 0));
        const createdAtB = Number(new Date(b?.createdAt || 0));
        return createdAtB - createdAtA;
      })
      .slice(0, 8)
      .map((item, index) => {
        const typeIconKey = getPostTypeIconKey(item?.type);
        return {
          id: item.id || '',
          key: item.id || `top-post-${index}`,
          imageUrl: getPostImageUrl(item),
          title: item.title || `${toTitleCase(item.type || 'post')} update`,
          authorLabel: getPostAuthorDisplayName(item),
          typeIconKey,
          typeIconPaths: getPostTypeIconPaths(item?.type),
        };
      })
  ), [feedItems]);

  return (
    <div className="home-feed-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      <section className="home-composer-grid">
        <section className="panel composer-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Create</p>
              <h3>New Feed Post</h3>
            </div>
          </div>

          {!isAuthenticated && (
            <div className="inline-alert warn-alert">
              <p>
                Guest mode is active. You can browse the feed, but posting requires authentication.
                <Link to="/login"> Sign in</Link> or <Link to="/signup"> create an account</Link>.
              </p>
            </div>
          )}

          <form className="composer-horizontal-form" onSubmit={handleCreatePost}>
            <div className="composer-quick-row">
              <span className="composer-avatar-badge" aria-hidden="true">{composerAvatar}</span>

              <label className="sr-only" htmlFor="new-post-summary">Summary</label>
              <input
                id="new-post-summary"
                className="composer-summary-input"
                type="text"
                placeholder={isAuthenticated ? "What's on your mind?" : 'Sign in to write a post summary'}
                value={postForm.summary}
                onChange={(e) => updatePostField('summary', e.target.value)}
                disabled={!isAuthenticated}
              />

              <div className="composer-action-row">
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="composer-image-input"
                  onChange={handleImageSelected}
                  disabled={!isAuthenticated}
                />
                <button
                  className="btn btn-soft composer-image-btn"
                  type="button"
                  onClick={openImagePicker}
                  disabled={!isAuthenticated}
                  aria-label="Add picture"
                  title="Add picture"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 5h4l1.2-1.8A2 2 0 0 1 10.9 2h2.2a2 2 0 0 1 1.7 1.2L16 5h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm8 3.5A5.5 5.5 0 1 0 12 19a5.5 5.5 0 0 0 0-11zm0 2A3.5 3.5 0 1 1 8.5 14 3.5 3.5 0 0 1 12 10.5z" />
                  </svg>
                </button>
                <button className="btn btn-primary-solid composer-submit-btn" type="submit" disabled={submittingPost || !isAuthenticated}>
                  {submittingPost ? 'Creating...' : 'Create Post'}
                </button>
              </div>
            </div>

            {composerImage && (
              <div className="composer-image-preview">
                <img src={composerImage.dataUrl} alt={composerImage.fileName || 'Selected upload'} />
                <div className="composer-image-meta">
                  <p>{composerImage.fileName}</p>
                  <button type="button" className="btn btn-soft" onClick={clearComposerImage}>
                    Remove
                  </button>
                </div>
              </div>
            )}

            <div className="composer-details-row">
              <label className="composer-field field-type">
                <span>Type</span>
                <select value={postForm.type} onChange={(e) => updatePostField('type', e.target.value)} disabled={!isAuthenticated}>
                  {allowedComposerTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="composer-field field-status">
                <span>Status</span>
                <select value={postForm.status} onChange={(e) => updatePostField('status', e.target.value)} disabled={!isAuthenticated}>
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                  <option value="archived">Archived</option>
                </select>
              </label>

              <label className="composer-field field-title">
                <span>Title</span>
                <input
                  type="text"
                  placeholder="Optional headline"
                  value={postForm.title}
                  onChange={(e) => updatePostField('title', e.target.value)}
                  disabled={!isAuthenticated}
                />
              </label>

              <label className="composer-field field-tags">
                <span>Tags</span>
                <div className="composer-tag-search-shell">
                  <input
                    className="composer-tag-search-input"
                    type="search"
                    placeholder={tags.length === 0 ? 'No tags available' : 'Search tags and press Enter'}
                    value={tagSearchInput}
                    onChange={(e) => setTagSearchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      if (!normalizedTagQuery || filteredTagResults.length === 0) return;
                      e.preventDefault();
                      addTagToComposer(filteredTagResults[0].id);
                    }}
                    disabled={!isAuthenticated || tags.length === 0}
                  />

                  {isAuthenticated && normalizedTagQuery && filteredTagResults.length > 0 && (
                    <ul className="composer-tag-results" role="listbox" aria-label="Matching tags">
                      {filteredTagResults.map((tag) => (
                        <li key={tag.id}>
                          <button type="button" onClick={() => addTagToComposer(tag.id)}>
                            <span>{tag.name}</span>
                            <small>{tag.slug}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {selectedComposerTags.length > 0 && (
                  <div className="composer-selected-tags" aria-label="Selected tags">
                    {selectedComposerTags.map((tag) => (
                      <button
                        type="button"
                        className="composer-tag-chip"
                        key={tag.id}
                        onClick={() => removeTagFromComposer(tag.id)}
                        aria-label={`Remove tag ${tag.name}`}
                        title={`Remove ${tag.name}`}
                      >
                        <span>{tag.name}</span>
                        <strong aria-hidden="true">x</strong>
                      </button>
                    ))}
                  </div>
                )}

                <small className="composer-tag-hint">
                  {tags.length === 0
                    ? 'No tags available yet.'
                    : `${composerSelectedTagIds.length} tag(s) selected.`}
                </small>
              </label>

              <label className="composer-field field-expires">
                <span>Expires</span>
                <input
                  type="datetime-local"
                  value={postForm.expiresAt}
                  onChange={(e) => updatePostField('expiresAt', e.target.value)}
                  disabled={!isAuthenticated}
                />
              </label>
            </div>
          </form>
        </section>

      </section>

      <section className="story-strip" aria-label="Top posts">
        {topPostItems.length === 0 ? (
          <article className="story-card story-card-empty">
            <div className="story-overlay">
              <strong>No top posts yet</strong>
              <small>Create a post to populate this section.</small>
            </div>
          </article>
        ) : (
          topPostItems.map((story) => (
            <article
              className={`story-card${story.id ? ' is-linkable' : ''}`}
              key={story.key}
              role={story.id ? 'link' : undefined}
              tabIndex={story.id ? 0 : undefined}
              onClick={story.id ? () => openPostDetails(story.id) : undefined}
              onKeyDown={story.id ? (event) => handleCardKeyNavigation(event, story.id) : undefined}
            >
              {story.imageUrl ? (
                <img src={story.imageUrl} alt={story.title} loading="lazy" />
              ) : (
                <div className={`story-fallback-bg story-fallback-${story.typeIconKey}`} aria-hidden="true">
                  <span className="story-fallback-icon-shell">
                    <svg
                      className="story-fallback-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {story.typeIconPaths.map((command, pathIndex) => (
                        <path key={`${story.typeIconKey}-${pathIndex}`} d={command} />
                      ))}
                    </svg>
                  </span>
                </div>
              )}
              <div className="story-overlay">
                <strong>{story.title}</strong>
                <small>{story.authorLabel}</small>
              </div>
            </article>
          ))
        )}
      </section>

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

      <section className="panel feed-panel">
        <div className="panel-header feed-header">
          <div>
            <p className="eyebrow">Explore</p>
            <h3>Unified Feed</h3>
          </div>
          <div className="header-actions">
            <span className="pill">{loadingFeed ? 'Refreshing...' : `${feedItems.length} card(s)`}</span>
            <button className="btn btn-soft" type="button" onClick={refreshFeed}>Refresh</button>
          </div>
        </div>

        <form className="feed-filters" onSubmit={(e) => e.preventDefault()}>
          <label>
            <span>Search</span>
            <input
              type="search"
              placeholder="Search title or summary"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </label>
          <label>
            <span>Type</span>
            <select value={filters.type} onChange={(e) => updateFilter('type', e.target.value)}>
              <option value="">All</option>
              <option value="ANNOUNCEMENT">Announcement</option>
              <option value="JOB">Job</option>
              <option value="EVENT">Event</option>
              <option value="EVENT_RECAP">Event Recap</option>
              <option value="ACHIEVEMENT">Achievement</option>
              <option value="collab">Collaboration</option>
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)}>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label>
            <span>Tag</span>
            <select value={filters.tag} onChange={(e) => updateFilter('tag', e.target.value)}>
              <option value="">All tags</option>
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          </label>
          <label className="check-row compact">
            <input
              type="checkbox"
              checked={filters.pinnedOnly}
              onChange={(e) => updateFilter('pinnedOnly', e.target.checked)}
            />
            <span>Pinned only</span>
          </label>
        </form>

        {feedError && (
          <div className="inline-alert" role="alert">
            <p>{feedError}</p>
          </div>
        )}

        {loadingFeed ? (
          <div className="skeleton-grid" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="feed-card skeleton-card" key={index} />
            ))}
          </div>
        ) : feedItems.length === 0 ? (
          <div className="empty-state">
            <h4>No posts match the current filters</h4>
            <p>Create a post above, or relax the filters to repopulate the feed.</p>
          </div>
        ) : (
          <div className="feed-grid">
            {feedItems.map((item, index) => {
              const postImageUrl = getPostImageUrl(item);
              const authorLabel = getPostAuthorDisplayName(item);
              const authorId = item?.author?.id || item?.authorId || null;
              const isEventPost = isEventPostType(item?.type);
              const canVolunteer = isVolunteerEligibleEvent(item) && String(item?.authorId || '') !== currentUserId;
              const alreadyEnrolled = Boolean(item?.viewerHasVolunteerEnrollment);
              const eventEnded = isEventOver(item);
              const volunteerCount = Number.isFinite(Number(item?.volunteerCount))
                ? Math.max(0, Math.trunc(Number(item.volunteerCount)))
                : 0;

              return (
                <article
                  className={`feed-card social-post-card feed-card-linkable${isEventPost ? ' is-event-post' : ''}`}
                  key={item.id}
                  style={{ '--card-index': index }}
                  role="link"
                  tabIndex={0}
                  onClick={(event) => handleCardNavigation(event, item.id)}
                  onKeyDown={(event) => handleCardKeyNavigation(event, item.id)}
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

                      {(isModerator || isPostOwner(item)) && (
                        <PostActionsMenu
                          buttonLabel={`Open actions for ${getPostLabel(item)}`}
                          menuLabel={`Post actions for ${getPostLabel(item)}`}
                          actions={[
                            {
                              key: 'archive',
                              label: 'Archive',
                              disabled: actionBusyPostId === item.id || !isAuthenticated || item.status === 'archived',
                              onSelect: () => patchPost(item.id, { archive: true }, 'Post archived.'),
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
                  </div>

                  {postImageUrl && (
                    <div className="feed-image-wrap">
                      <img
                        src={postImageUrl}
                        alt={item.title || 'Post image'}
                        loading="lazy"
                      />
                    </div>
                  )}

                  <p className="feed-summary">{item.summary || 'No summary provided.'}</p>

                  {isEventPost && <EventMetadataBlock post={item} variant="card" />}

                  {Array.isArray(item.tags) && item.tags.length > 0 && (
                    <ul className="mini-tag-row" aria-label="Post tags">
                      {item.tags.map((tag) => (
                        <li key={`${item.id}-${tag.id}`}>
                          <button type="button" className="mini-tag" onClick={() => updateFilter('tag', tag.id)}>
                            #{tag.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="post-utility-bar">
                    <span className="pill">{item.type || 'UNKNOWN'}</span>
                    {item.expiresAt && <span className="pill">Expires {formatDate(item.expiresAt)}</span>}
                    {isVolunteerEligibleEvent(item) && <span className="pill">Volunteers {volunteerCount}</span>}
                    {authorId ? (
                      <button
                        type="button"
                        className="pill author-nav-pill"
                        title={authorLabel}
                        onClick={(event) => navigateToProfile(event, authorId)}
                      >
                        {authorLabel}
                      </button>
                    ) : (
                      <span className="pill" title={authorLabel}>{authorLabel}</span>
                    )}
                  </div>

                  <div className="feed-card-actions social-actions reddit-action-row">
                    <div className="reddit-vote-group" role="group" aria-label={`Voting controls for ${item.title || 'post'}`}>
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

                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
