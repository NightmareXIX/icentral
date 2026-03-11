const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

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

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function getJobDetailsFromPost(post) {
  const refs = Array.isArray(post?.refs) ? post.refs : [];
  const jobRef = refs.find((ref) => String(ref?.service || '').toLowerCase() === 'job-details');
  const metadata = jobRef?.metadata && typeof jobRef.metadata === 'object'
    ? jobRef.metadata
    : {};

  const jobTitle = normalizeText(metadata.jobTitle) || normalizeText(post?.title);
  const companyName = normalizeText(metadata.companyName);
  const jobDescription = normalizeText(metadata.jobDescription) || normalizeText(post?.summary);
  const salaryRange = normalizeText(metadata.salaryRange);

  return {
    jobTitle: jobTitle || 'Untitled position',
    companyName: companyName || 'Company not specified',
    jobDescription: jobDescription || 'No job description provided.',
    salaryRange: salaryRange || 'Not specified',
    deadline: post?.expiresAt || null,
  };
}

export async function createJobApplication(payload) {
  const result = await apiRequest('/jobs/applications', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return result?.data || null;
}

export async function getApplicationsForPost(postId, options = {}) {
  const normalizedPostId = String(postId || '').trim();
  if (!normalizedPostId) return [];

  const result = await apiRequest(`/jobs/posts/${encodeURIComponent(normalizedPostId)}/applications`, options);
  return Array.isArray(result?.data) ? result.data : [];
}

export async function getUnreadJobApplicationNotificationsForUser(_userId, options = {}) {
  void _userId;
  const result = await apiRequest('/jobs/notifications/unread', options);
  return Array.isArray(result?.data) ? result.data : [];
}

export async function markJobApplicationNotificationRead(notificationId) {
  const normalizedId = String(notificationId || '').trim();
  if (!normalizedId) return;

  await apiRequest(`/jobs/notifications/${encodeURIComponent(normalizedId)}/read`, {
    method: 'POST',
  });
}

export async function markAllJobApplicationNotificationsReadForUser(_userId) {
  void _userId;
  await apiRequest('/jobs/notifications/read-all', {
    method: 'POST',
  });
}
