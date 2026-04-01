import { apiRequest } from './profileApi';

export const REQUEST_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
};

export const COLLAB_STATUSES = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
};

export const COLLAB_MODES = ['ONSITE', 'REMOTE', 'HYBRID'];

export const COLLAB_CATEGORIES = [
  'Research Assistant',
  'Thesis Partner',
  'Project Team-Up',
  'Hackathon Team',
  'Study Group',
  'Other Academic Collaboration',
];

const COLLAB_POSTS_PATH = '/posts/collab-posts';
const JOIN_REQUESTS_PATH = '/posts/join-requests';

function toTitleCase(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function normalizeRoleLabel(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'admin') return 'Admin';
  if (normalized === 'faculty') return 'Faculty';
  if (normalized === 'alumni') return 'Alumni';
  if (normalized === 'student') return 'Student';
  if (!normalized) return 'Member';
  return toTitleCase(normalized);
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'REMOTE') return 'REMOTE';
  if (normalized === 'ONSITE') return 'ONSITE';
  return 'HYBRID';
}

function normalizeModeForApi(value) {
  const normalized = normalizeMode(value);
  if (normalized === 'REMOTE') return 'remote';
  if (normalized === 'ONSITE') return 'onsite';
  return 'hybrid';
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === COLLAB_STATUSES.CLOSED
    ? COLLAB_STATUSES.CLOSED
    : COLLAB_STATUSES.OPEN;
}

function normalizeStatusForApi(value) {
  return normalizeStatus(value) === COLLAB_STATUSES.CLOSED
    ? 'closed'
    : 'open';
}

function normalizeRequestStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === REQUEST_STATUS.ACCEPTED) return REQUEST_STATUS.ACCEPTED;
  if (normalized === REQUEST_STATUS.REJECTED) return REQUEST_STATUS.REJECTED;
  return REQUEST_STATUS.PENDING;
}

function normalizeSortForApi(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'DEADLINE' ? 'deadline' : 'newest';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function uniqueTrimmedValues(values = []) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function parseStringListInput(value) {
  if (Array.isArray(value)) return uniqueTrimmedValues(value);
  if (typeof value === 'string') return uniqueTrimmedValues(value.split(','));
  return [];
}

function normalizeJoinRequest(request = {}) {
  return {
    id: normalizeText(request.id),
    postId: normalizeText(request.postId || request.post_id),
    userId: normalizeText(request.userId || request.user_id),
    message: normalizeText(request.message),
    status: normalizeRequestStatus(request.status),
    createdAt: request.createdAt || request.created_at || null,
    updatedAt: request.updatedAt || request.updated_at || null,
    reviewedAt: request.reviewedAt || request.reviewed_at || null,
    applicantName: normalizeText(request.applicantName)
      || normalizeText(request.applicant?.fullName)
      || normalizeText(request.applicant?.email)
      || 'Community member',
    applicantRole: normalizeText(request.applicantRole)
      || normalizeRoleLabel(request.applicant?.role),
    applicant: request.applicant || null,
  };
}

function normalizeMember(member = {}) {
  return {
    id: normalizeText(member.id),
    postId: normalizeText(member.postId || member.post_id),
    userId: normalizeText(member.userId || member.user_id),
    name: normalizeText(member.name)
      || normalizeText(member.user?.fullName)
      || normalizeText(member.user?.email)
      || 'Collaborator',
    role: normalizeText(member.role) || normalizeRoleLabel(member.user?.role),
    teamRole: normalizeText(member.teamRole || member.team_role) || null,
    acceptedAt: member.acceptedAt || member.createdAt || member.created_at || null,
    user: member.user || null,
  };
}

function normalizeTagNames(rawTags = []) {
  if (!Array.isArray(rawTags)) return [];
  return uniqueTrimmedValues(rawTags.map((tag) => {
    if (typeof tag === 'string') return tag;
    return tag?.name;
  }));
}

function normalizeCollabPost(rawPost = {}) {
  const creatorId = normalizeText(rawPost?.creator?.id || rawPost?.authorId || rawPost?.author?.id);
  const creatorName = normalizeText(rawPost?.creator?.name)
    || normalizeText(rawPost?.author?.fullName)
    || normalizeText(rawPost?.author?.email)
    || 'Community member';
  const creatorRole = normalizeText(rawPost?.creator?.role)
    || normalizeRoleLabel(rawPost?.author?.role);

  const requiredSkills = parseStringListInput(rawPost.requiredSkills || rawPost.required_skills);
  const tagNames = normalizeTagNames(rawPost.tags);
  const requests = Array.isArray(rawPost.requests)
    ? rawPost.requests.map(normalizeJoinRequest)
    : [];
  const collaborators = Array.isArray(rawPost.collaborators)
    ? rawPost.collaborators.map(normalizeMember)
    : [];

  const memberCount = Number.isFinite(Number(rawPost.memberCount))
    ? Math.max(0, Math.trunc(Number(rawPost.memberCount)))
    : collaborators.length;
  const joinRequestCount = Number.isFinite(Number(rawPost.joinRequestCount))
    ? Math.max(0, Math.trunc(Number(rawPost.joinRequestCount)))
    : requests.length;
  const pendingRequestCount = Number.isFinite(Number(rawPost.pendingRequestCount))
    ? Math.max(0, Math.trunc(Number(rawPost.pendingRequestCount)))
    : requests.filter((request) => normalizeRequestStatus(request.status) === REQUEST_STATUS.PENDING).length;

  const openings = Number.isFinite(Number(rawPost.openings))
    ? Math.max(1, Math.trunc(Number(rawPost.openings)))
    : 1;
  const openingsLeft = Number.isFinite(Number(rawPost.openingsLeft))
    ? Math.max(0, Math.trunc(Number(rawPost.openingsLeft)))
    : Math.max(0, openings - memberCount);

  return {
    id: normalizeText(rawPost.id),
    type: normalizeText(rawPost.type || 'collab') || 'collab',
    title: normalizeText(rawPost.title),
    summary: normalizeText(rawPost.summary),
    description: normalizeText(rawPost.description),
    category: normalizeText(rawPost.category),
    creator: {
      id: creatorId,
      name: creatorName,
      role: creatorRole || 'Member',
    },
    authorId: normalizeText(rawPost.authorId || rawPost.author_id) || creatorId,
    author: rawPost.author || null,
    requiredSkills,
    preferredBackground: normalizeText(rawPost.preferredBackground || rawPost.preferred_background),
    timeCommitmentHoursPerWeek: Number.isFinite(Number(rawPost.timeCommitmentHoursPerWeek))
      ? Math.max(1, Math.trunc(Number(rawPost.timeCommitmentHoursPerWeek)))
      : Number.isFinite(Number(rawPost.time_commitment_hours_per_week))
        ? Math.max(1, Math.trunc(Number(rawPost.time_commitment_hours_per_week)))
        : 1,
    duration: normalizeText(rawPost.duration),
    mode: normalizeMode(rawPost.mode),
    openings,
    status: normalizeStatus(rawPost.status),
    joinUntil: rawPost.joinUntil || rawPost.deadline || null,
    deadline: rawPost.deadline || rawPost.joinUntil || null,
    createdAt: rawPost.createdAt || rawPost.created_at || null,
    updatedAt: rawPost.updatedAt || rawPost.updated_at || null,
    tags: tagNames,
    tagObjects: Array.isArray(rawPost.tagObjects)
      ? rawPost.tagObjects
      : Array.isArray(rawPost.tags)
        ? rawPost.tags.filter((tag) => tag && typeof tag === 'object')
        : [],
    joinRequestCount,
    pendingRequestCount,
    memberCount,
    openingsLeft,
    postStatus: normalizeText(rawPost.postStatus || rawPost.post_status),
    requests,
    collaborators,
    currentUserRequest: rawPost.currentUserRequest
      ? normalizeJoinRequest(rawPost.currentUserRequest)
      : null,
  };
}

function buildCollabPayload(payload = {}) {
  const requiredSkills = parseStringListInput(payload.requiredSkills);
  const tags = parseStringListInput(payload.tags);

  return {
    title: normalizeText(payload.title),
    summary: normalizeText(payload.summary),
    description: normalizeText(payload.description),
    category: normalizeText(payload.category),
    requiredSkills,
    preferredBackground: normalizeText(payload.preferredBackground) || null,
    timeCommitmentHoursPerWeek: Number.isFinite(Number(payload.timeCommitmentHoursPerWeek))
      ? Math.max(1, Math.trunc(Number(payload.timeCommitmentHoursPerWeek)))
      : payload.timeCommitmentHoursPerWeek,
    duration: normalizeText(payload.duration),
    mode: normalizeModeForApi(payload.mode),
    openings: Number.isFinite(Number(payload.openings))
      ? Math.max(1, Math.trunc(Number(payload.openings)))
      : payload.openings,
    joinUntil: payload.joinUntil || null,
    tags,
  };
}

async function fetchCollabMembersRaw(postId) {
  const result = await apiRequest(`${COLLAB_POSTS_PATH}/${encodeURIComponent(postId)}/members`);
  return Array.isArray(result?.data) ? result.data : [];
}

async function fetchCollabRequestsRaw(postId, status = 'all') {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const query = params.toString();
  const path = `${COLLAB_POSTS_PATH}/${encodeURIComponent(postId)}/join-requests${query ? `?${query}` : ''}`;
  const result = await apiRequest(path);
  return Array.isArray(result?.data) ? result.data : [];
}

export function getCollabOpeningsLeft(post) {
  if (Number.isFinite(Number(post?.openingsLeft))) {
    return Math.max(0, Math.trunc(Number(post.openingsLeft)));
  }

  const openings = Number.isFinite(Number(post?.openings))
    ? Math.max(1, Math.trunc(Number(post.openings)))
    : 1;
  const memberCount = Number.isFinite(Number(post?.memberCount))
    ? Math.max(0, Math.trunc(Number(post.memberCount)))
    : Array.isArray(post?.collaborators)
      ? post.collaborators.length
      : 0;

  return Math.max(0, openings - memberCount);
}

export function getCollabPendingRequestCount(post) {
  if (Number.isFinite(Number(post?.pendingRequestCount))) {
    return Math.max(0, Math.trunc(Number(post.pendingRequestCount)));
  }

  const requests = Array.isArray(post?.requests) ? post.requests : [];
  return requests.filter((request) => normalizeRequestStatus(request?.status) === REQUEST_STATUS.PENDING).length;
}

export function getCollabRequestForUser(post, userId) {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) return null;

  if (post?.currentUserRequest && normalizeText(post.currentUserRequest.userId) === normalizedUserId) {
    return normalizeJoinRequest(post.currentUserRequest);
  }

  const requests = Array.isArray(post?.requests) ? post.requests : [];
  const request = requests.find((item) => normalizeText(item?.userId) === normalizedUserId);
  return request ? normalizeJoinRequest(request) : null;
}

export async function listCollabPosts(filters = {}) {
  const params = new URLSearchParams();

  if (filters.category) params.set('category', normalizeText(filters.category));
  if (filters.status) params.set('status', normalizeStatusForApi(filters.status));
  if (filters.mode) params.set('mode', normalizeModeForApi(filters.mode));
  if (filters.skillTag) params.set('skill', normalizeText(filters.skillTag));
  if (filters.authorId) params.set('author', normalizeText(filters.authorId));
  if (filters.q) params.set('q', normalizeText(filters.q));
  if (filters.sortBy || filters.sort) params.set('sort', normalizeSortForApi(filters.sortBy || filters.sort));
  if (Number.isFinite(Number(filters.limit))) params.set('limit', String(Math.max(1, Math.trunc(Number(filters.limit)))));
  if (Number.isFinite(Number(filters.offset))) params.set('offset', String(Math.max(0, Math.trunc(Number(filters.offset)))));

  const query = params.toString();
  const path = `${COLLAB_POSTS_PATH}${query ? `?${query}` : ''}`;
  const result = await apiRequest(path);

  const items = Array.isArray(result?.data)
    ? result.data.map(normalizeCollabPost)
    : Array.isArray(result?.items)
      ? result.items.map(normalizeCollabPost)
      : [];

  return {
    items,
    pagination: result?.pagination || null,
    meta: result?.meta || null,
  };
}

export async function getCollabPostById(postId) {
  const normalizedPostId = normalizeText(postId);
  if (!normalizedPostId) return null;

  const result = await apiRequest(`${COLLAB_POSTS_PATH}/${encodeURIComponent(normalizedPostId)}`);
  const normalizedPost = normalizeCollabPost(result?.data || {});

  if (!normalizedPost?.id) return null;

  const [membersResult, requestsResult] = await Promise.all([
    fetchCollabMembersRaw(normalizedPostId).catch(() => []),
    fetchCollabRequestsRaw(normalizedPostId, 'all').catch((error) => {
      const message = String(error?.message || '').toLowerCase();
      if (
        message.includes('only the post owner')
        || message.includes('authentication required')
        || message.includes('route not found')
      ) {
        return [];
      }
      throw error;
    }),
  ]);

  const collaborators = Array.isArray(membersResult) ? membersResult.map(normalizeMember) : [];
  const requests = Array.isArray(requestsResult) ? requestsResult.map(normalizeJoinRequest) : [];

  const pendingRequestCount = requests.length > 0
    ? requests.filter((request) => normalizeRequestStatus(request.status) === REQUEST_STATUS.PENDING).length
    : normalizedPost.pendingRequestCount;

  return {
    ...normalizedPost,
    collaborators,
    requests,
    memberCount: collaborators.length > 0 ? collaborators.length : normalizedPost.memberCount,
    joinRequestCount: requests.length > 0 ? requests.length : normalizedPost.joinRequestCount,
    pendingRequestCount,
    openingsLeft: getCollabOpeningsLeft({
      ...normalizedPost,
      collaborators,
      memberCount: collaborators.length > 0 ? collaborators.length : normalizedPost.memberCount,
    }),
  };
}

export async function createCollabPost(payload, _currentUser) {
  void _currentUser;
  const body = buildCollabPayload(payload);
  const result = await apiRequest(COLLAB_POSTS_PATH, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return normalizeCollabPost(result?.data || {});
}

export async function updateCollabPost(postId, payload, _currentUser) {
  void _currentUser;
  const normalizedPostId = normalizeText(postId);
  const body = buildCollabPayload(payload);
  const result = await apiRequest(`${COLLAB_POSTS_PATH}/${encodeURIComponent(normalizedPostId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return normalizeCollabPost(result?.data || {});
}

export async function submitCollabJoinRequest(postId, _currentUser, message) {
  void _currentUser;
  const normalizedPostId = normalizeText(postId);
  const normalizedMessage = normalizeText(message);

  await apiRequest(`${COLLAB_POSTS_PATH}/${encodeURIComponent(normalizedPostId)}/join-requests`, {
    method: 'POST',
    body: JSON.stringify({ message: normalizedMessage }),
  });

  return getCollabPostById(normalizedPostId);
}

export async function reviewCollabJoinRequest(postId, requestId, nextStatus, _actingUser) {
  void _actingUser;
  const normalizedRequestId = normalizeText(requestId);
  const normalizedStatus = normalizeRequestStatus(nextStatus);

  await apiRequest(`${JOIN_REQUESTS_PATH}/${encodeURIComponent(normalizedRequestId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: normalizedStatus.toLowerCase(),
    }),
  });

  return getCollabPostById(postId);
}

export async function setCollabPostStatus(postId, nextStatus, _actingUser) {
  void _actingUser;
  const normalizedPostId = normalizeText(postId);
  const normalizedStatus = normalizeStatus(nextStatus);

  await apiRequest(`${COLLAB_POSTS_PATH}/${encodeURIComponent(normalizedPostId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: normalizedStatus.toLowerCase(),
    }),
  });

  return getCollabPostById(normalizedPostId);
}

export async function listCollabJoinRequests(postId, { status = 'pending' } = {}) {
  const normalizedPostId = normalizeText(postId);
  const normalizedStatus = normalizeText(status).toLowerCase() || 'pending';
  const rows = await fetchCollabRequestsRaw(normalizedPostId, normalizedStatus);
  return rows.map(normalizeJoinRequest);
}

export async function listCollabMembers(postId) {
  const normalizedPostId = normalizeText(postId);
  const rows = await fetchCollabMembersRaw(normalizedPostId);
  return rows.map(normalizeMember);
}
