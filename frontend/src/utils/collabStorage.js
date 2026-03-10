const COLLAB_STORAGE_KEY = 'icentral-collab-posts-v1';
const COLLAB_UPDATED_EVENT = 'icentral:collab-updated';

const REQUEST_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
};

const COLLAB_STATUSES = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
};

const COLLAB_MODES = ['ONSITE', 'REMOTE', 'HYBRID'];

const COLLAB_CATEGORIES = [
  'Research Assistant',
  'Thesis Partner',
  'Project Team-Up',
  'Hackathon Team',
  'Study Group',
  'Other Academic Collaboration',
];

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function safeParseJson(rawValue) {
  if (!rawValue) return null;
  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function uniqueTrimmedValues(values = []) {
  const unique = new Set();
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
}

function parseCsvValues(value) {
  return uniqueTrimmedValues(String(value || '').split(','));
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return COLLAB_MODES.includes(normalized) ? normalized : 'HYBRID';
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === COLLAB_STATUSES.CLOSED) return COLLAB_STATUSES.CLOSED;
  return COLLAB_STATUSES.OPEN;
}

function normalizeRequestStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === REQUEST_STATUS.ACCEPTED) return REQUEST_STATUS.ACCEPTED;
  if (normalized === REQUEST_STATUS.REJECTED) return REQUEST_STATUS.REJECTED;
  return REQUEST_STATUS.PENDING;
}

function normalizeCategory(value) {
  const normalized = String(value || '').trim();
  if (COLLAB_CATEGORIES.includes(normalized)) return normalized;
  return 'Other Academic Collaboration';
}

function normalizeIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeDeadline(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return normalizeIsoDate(`${raw}T23:59:59`);
  }
  return normalizeIsoDate(raw);
}

function normalizeRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'member';
  return normalized;
}

function normalizeDisplayRole(value) {
  const role = normalizeRole(value);
  if (role === 'admin') return 'Admin';
  if (role === 'faculty') return 'Faculty';
  if (role === 'alumni') return 'Alumni';
  if (role === 'student') return 'Student';
  return 'Member';
}

function getUserDisplayName(user, fallback = 'Community member') {
  const candidate = [
    user?.full_name,
    user?.fullName,
    user?.name,
    user?.username,
    user?.email,
  ].find((value) => String(value || '').trim());
  return String(candidate || fallback).trim();
}

function getUserId(user) {
  const id = String(user?.id || '').trim();
  return id || null;
}

function createId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOpeningsLeft(post) {
  const requestedOpenings = Number(post?.openings);
  const openings = Number.isFinite(requestedOpenings) ? Math.max(1, Math.trunc(requestedOpenings)) : 1;
  const collaborators = Array.isArray(post?.collaborators) ? post.collaborators.length : 0;
  return Math.max(0, openings - collaborators);
}

function getPendingRequestCount(post) {
  const requests = Array.isArray(post?.requests) ? post.requests : [];
  return requests.filter((item) => normalizeRequestStatus(item?.status) === REQUEST_STATUS.PENDING).length;
}

function normalizePost(rawPost) {
  const creator = rawPost?.creator || {};
  const normalizedRequests = Array.isArray(rawPost?.requests)
    ? rawPost.requests.map((request) => ({
      id: String(request?.id || createId('collab-request')),
      userId: String(request?.userId || '').trim(),
      applicantName: String(request?.applicantName || 'Community member').trim(),
      applicantRole: normalizeDisplayRole(request?.applicantRole),
      message: String(request?.message || '').trim(),
      status: normalizeRequestStatus(request?.status),
      createdAt: normalizeIsoDate(request?.createdAt) || new Date().toISOString(),
      reviewedAt: normalizeIsoDate(request?.reviewedAt),
    }))
    : [];

  const normalizedCollaborators = Array.isArray(rawPost?.collaborators)
    ? rawPost.collaborators.map((member) => ({
      userId: String(member?.userId || '').trim(),
      name: String(member?.name || 'Collaborator').trim(),
      role: normalizeDisplayRole(member?.role),
      acceptedAt: normalizeIsoDate(member?.acceptedAt) || new Date().toISOString(),
    }))
    : [];

  return {
    id: String(rawPost?.id || createId('collab-post')),
    title: String(rawPost?.title || '').trim(),
    summary: String(rawPost?.summary || '').trim(),
    description: String(rawPost?.description || '').trim(),
    category: normalizeCategory(rawPost?.category),
    creator: {
      id: String(creator?.id || '').trim(),
      name: getUserDisplayName(creator),
      role: normalizeDisplayRole(creator?.role),
    },
    requiredSkills: uniqueTrimmedValues(rawPost?.requiredSkills),
    preferredBackground: String(rawPost?.preferredBackground || '').trim(),
    timeCommitmentHoursPerWeek: Math.max(1, Math.trunc(Number(rawPost?.timeCommitmentHoursPerWeek) || 1)),
    duration: String(rawPost?.duration || '').trim() || 'Not specified',
    mode: normalizeMode(rawPost?.mode),
    openings: Math.max(1, Math.trunc(Number(rawPost?.openings) || 1)),
    status: normalizeStatus(rawPost?.status),
    joinUntil: normalizeDeadline(rawPost?.joinUntil),
    createdAt: normalizeIsoDate(rawPost?.createdAt) || new Date().toISOString(),
    tags: uniqueTrimmedValues(rawPost?.tags),
    requests: normalizedRequests,
    collaborators: normalizedCollaborators,
  };
}

function shiftIsoFromNow({ days = 0, hours = 0 } = {}) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  date.setHours(date.getHours() + Number(hours || 0));
  return date.toISOString();
}

function seedCollabPosts() {
  return [
    normalizePost({
      id: 'collab-seed-ra-call',
      title: 'NLP Research Assistant (Dataset Cleaning + Baseline Models)',
      summary: 'Faculty-led call for 2 assistants to support data preparation and model benchmarking.',
      description: 'We are building a Bangla academic text corpus for downstream NLP tasks. Selected collaborators will help with annotation quality checks, baseline experiments, and documentation for lab reports.',
      category: 'Research Assistant',
      creator: {
        id: 'faculty-dr-rahman',
        name: 'Dr. A. Rahman',
        role: 'faculty',
      },
      requiredSkills: ['Python', 'Pandas', 'Machine Learning Basics', 'Git'],
      preferredBackground: '3rd/4th year ICE/CSE students with prior ML coursework',
      timeCommitmentHoursPerWeek: 6,
      duration: '12 weeks (semester-long)',
      mode: 'HYBRID',
      openings: 2,
      status: 'OPEN',
      joinUntil: shiftIsoFromNow({ days: 12 }),
      createdAt: shiftIsoFromNow({ days: -2 }),
      tags: ['nlp', 'research', 'dataset'],
      collaborators: [],
      requests: [],
    }),
    normalizePost({
      id: 'collab-seed-thesis-partner',
      title: 'Thesis Partner Needed for IoT Energy Monitoring',
      summary: 'Looking for one thesis partner for hardware-software integration and evaluation.',
      description: 'I am starting a thesis on low-cost energy monitoring in lab environments. Need a partner comfortable with microcontrollers and backend data pipelines. We will prepare conference-style documentation.',
      category: 'Thesis Partner',
      creator: {
        id: 'student-ice-1801',
        name: 'Farhan Ahmed',
        role: 'student',
      },
      requiredSkills: ['Embedded Systems', 'Node.js', 'SQL'],
      preferredBackground: 'Final year students preferred',
      timeCommitmentHoursPerWeek: 8,
      duration: '4 months',
      mode: 'ONSITE',
      openings: 1,
      status: 'OPEN',
      joinUntil: shiftIsoFromNow({ days: 20 }),
      createdAt: shiftIsoFromNow({ days: -5 }),
      tags: ['thesis', 'iot', 'energy'],
      collaborators: [],
      requests: [],
    }),
    normalizePost({
      id: 'collab-seed-study-group',
      title: 'Compiler Design Study Group (Advanced Prep)',
      summary: 'Structured peer group for weekly problem-solving and paper reading.',
      description: 'Forming a focused study group for compiler design and optimization topics. We will maintain weekly agendas, peer reviews, and short presentations to prepare for higher studies and interviews.',
      category: 'Study Group',
      creator: {
        id: 'alumni-rifat',
        name: 'Rifat Karim',
        role: 'alumni',
      },
      requiredSkills: ['C/C++', 'Data Structures', 'Algorithms'],
      preferredBackground: '2nd year and above',
      timeCommitmentHoursPerWeek: 4,
      duration: '8 weeks',
      mode: 'REMOTE',
      openings: 4,
      status: 'OPEN',
      joinUntil: shiftIsoFromNow({ days: 9 }),
      createdAt: shiftIsoFromNow({ days: -1, hours: -4 }),
      tags: ['study-group', 'compiler', 'interview-prep'],
      collaborators: [
        {
          userId: 'student-ice-1732',
          name: 'Nusrat Jahan',
          role: 'Student',
          acceptedAt: shiftIsoFromNow({ days: -1 }),
        },
      ],
      requests: [
        {
          id: 'collab-seed-request-1',
          userId: 'student-ice-1902',
          applicantName: 'Ayman Sadiq',
          applicantRole: 'Student',
          message: 'Interested in joining for optimization-focused practice and weekly coding sessions.',
          status: 'PENDING',
          createdAt: shiftIsoFromNow({ hours: -10 }),
        },
      ],
    }),
  ];
}

function dispatchStorageUpdate() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(COLLAB_UPDATED_EVENT));
}

function persistPosts(posts, options = {}) {
  if (!isBrowser()) return;
  const { emitEvent = true } = options;
  window.localStorage.setItem(COLLAB_STORAGE_KEY, JSON.stringify(posts));
  if (emitEvent) dispatchStorageUpdate();
}

function readPosts() {
  if (!isBrowser()) return seedCollabPosts();

  const stored = safeParseJson(window.localStorage.getItem(COLLAB_STORAGE_KEY));
  if (!Array.isArray(stored)) {
    const seeded = seedCollabPosts();
    persistPosts(seeded, { emitEvent: false });
    return seeded;
  }

  const normalized = stored.map(normalizePost);
  if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
    persistPosts(normalized, { emitEvent: false });
  }
  return normalized;
}

function writePostUpdate(postId, updater) {
  const posts = readPosts();
  const index = posts.findIndex((item) => String(item.id) === String(postId));
  if (index === -1) {
    throw new Error('Collaboration post not found.');
  }

  const updatedPost = normalizePost(updater(posts[index]));
  posts[index] = updatedPost;
  persistPosts(posts);
  return updatedPost;
}

function ensureOwner(post, actingUser) {
  const actingUserId = getUserId(actingUser);
  if (!actingUserId) {
    throw new Error('Authentication is required for this action.');
  }
  if (String(post?.creator?.id || '') !== String(actingUserId)) {
    throw new Error('Only the post owner can perform this action.');
  }
}

export {
  COLLAB_STORAGE_KEY,
  COLLAB_UPDATED_EVENT,
  COLLAB_CATEGORIES,
  COLLAB_MODES,
  COLLAB_STATUSES,
  REQUEST_STATUS,
};

export function listCollabPosts() {
  return readPosts();
}

export function getCollabPostById(postId) {
  const normalizedId = String(postId || '').trim();
  if (!normalizedId) return null;
  return readPosts().find((item) => String(item.id) === normalizedId) || null;
}

export function getCollabOpeningsLeft(post) {
  return getOpeningsLeft(post);
}

export function getCollabPendingRequestCount(post) {
  return getPendingRequestCount(post);
}

export function getCollabRequestForUser(post, userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId || !Array.isArray(post?.requests)) return null;
  const request = post.requests.find((item) => String(item?.userId || '').trim() === normalizedUserId);
  return request || null;
}

export function createCollabPost(payload, currentUser) {
  const creatorId = getUserId(currentUser);
  if (!creatorId) {
    throw new Error('Sign in to create collaboration posts.');
  }

  const posts = readPosts();
  const createdAt = new Date().toISOString();

  const createdPost = normalizePost({
    id: createId('collab-post'),
    title: payload?.title,
    summary: payload?.summary,
    description: payload?.description,
    category: payload?.category,
    creator: {
      id: creatorId,
      name: getUserDisplayName(currentUser),
      role: normalizeRole(currentUser?.role),
    },
    requiredSkills: Array.isArray(payload?.requiredSkills) ? payload.requiredSkills : parseCsvValues(payload?.requiredSkills),
    preferredBackground: payload?.preferredBackground,
    timeCommitmentHoursPerWeek: payload?.timeCommitmentHoursPerWeek,
    duration: payload?.duration,
    mode: payload?.mode,
    openings: payload?.openings,
    status: COLLAB_STATUSES.OPEN,
    joinUntil: normalizeDeadline(payload?.joinUntil),
    createdAt,
    tags: Array.isArray(payload?.tags) ? payload.tags : parseCsvValues(payload?.tags),
    collaborators: [],
    requests: [],
  });

  posts.unshift(createdPost);
  persistPosts(posts);
  return createdPost;
}

export function submitCollabJoinRequest(postId, currentUser, message) {
  const userId = getUserId(currentUser);
  if (!userId) {
    throw new Error('Sign in to request collaboration.');
  }

  const applicantName = getUserDisplayName(currentUser);
  const applicantRole = normalizeDisplayRole(currentUser?.role);
  const trimmedMessage = String(message || '').trim();
  if (!trimmedMessage) {
    throw new Error('Please include a short message with your request.');
  }

  return writePostUpdate(postId, (post) => {
    if (String(post?.creator?.id || '') === String(userId)) {
      throw new Error('You cannot request to join your own collaboration post.');
    }
    if (normalizeStatus(post?.status) !== COLLAB_STATUSES.OPEN) {
      throw new Error('This collaboration post is currently closed.');
    }

    const requests = Array.isArray(post.requests) ? [...post.requests] : [];
    const collaborators = Array.isArray(post.collaborators) ? [...post.collaborators] : [];

    if (collaborators.some((member) => String(member.userId || '') === String(userId))) {
      throw new Error('You are already part of this collaboration.');
    }

    const existing = requests.find((request) => String(request.userId || '') === String(userId));
    if (existing) {
      const currentStatus = normalizeRequestStatus(existing.status);
      if (currentStatus === REQUEST_STATUS.PENDING) {
        throw new Error('You already have a pending request for this post.');
      }
      if (currentStatus === REQUEST_STATUS.ACCEPTED) {
        throw new Error('Your request was already accepted for this post.');
      }
      existing.status = REQUEST_STATUS.PENDING;
      existing.message = trimmedMessage;
      existing.createdAt = new Date().toISOString();
      existing.reviewedAt = null;
      return {
        ...post,
        requests,
      };
    }

    requests.unshift({
      id: createId('collab-request'),
      userId,
      applicantName,
      applicantRole,
      message: trimmedMessage,
      status: REQUEST_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      reviewedAt: null,
    });

    return {
      ...post,
      requests,
    };
  });
}

export function reviewCollabJoinRequest(postId, requestId, nextStatus, actingUser) {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) {
    throw new Error('Request id is required.');
  }

  const normalizedStatus = normalizeRequestStatus(nextStatus);
  if (normalizedStatus !== REQUEST_STATUS.ACCEPTED && normalizedStatus !== REQUEST_STATUS.REJECTED) {
    throw new Error('Only ACCEPTED or REJECTED statuses are allowed.');
  }

  return writePostUpdate(postId, (post) => {
    ensureOwner(post, actingUser);

    const requests = Array.isArray(post.requests) ? [...post.requests] : [];
    const collaborators = Array.isArray(post.collaborators) ? [...post.collaborators] : [];

    const targetRequest = requests.find((request) => String(request.id) === normalizedRequestId);
    if (!targetRequest) {
      throw new Error('Join request not found.');
    }

    targetRequest.status = normalizedStatus;
    targetRequest.reviewedAt = new Date().toISOString();

    if (normalizedStatus === REQUEST_STATUS.ACCEPTED) {
      const alreadyCollaborator = collaborators.some((member) => (
        String(member.userId || '') === String(targetRequest.userId || '')
      ));

      if (!alreadyCollaborator) {
        collaborators.push({
          userId: String(targetRequest.userId || ''),
          name: String(targetRequest.applicantName || 'Collaborator'),
          role: normalizeDisplayRole(targetRequest.applicantRole),
          acceptedAt: new Date().toISOString(),
        });
      }
    }

    const openingsLeft = getOpeningsLeft({ ...post, collaborators });
    const shouldClose = openingsLeft <= 0;

    return {
      ...post,
      status: shouldClose ? COLLAB_STATUSES.CLOSED : post.status,
      requests,
      collaborators,
    };
  });
}

export function setCollabPostStatus(postId, nextStatus, actingUser) {
  const normalizedStatus = normalizeStatus(nextStatus);
  return writePostUpdate(postId, (post) => {
    ensureOwner(post, actingUser);
    return {
      ...post,
      status: normalizedStatus,
    };
  });
}
