import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/useAuth';
import { getUnreadJobApplicationNotificationsForUser } from '../../utils/jobPortalStorage';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

const FEED_SECTIONS = [
  { key: 'home', label: 'Home', to: '/home', hint: 'Main feed', roles: 'all'},
  { key: 'chat', label: 'Chat', to: '/chat', hint: 'Direct messages', roles: 'all'},
  { key: 'jobs', label: 'Job Portal', to: '/job-portal', hint: 'Career posts', roles: 'all'},
  { key: 'events', label: 'Events', to: '/events', hint: 'Campus events', roles: 'all'},
  { key: 'collaborate', label: 'Collaborate', to: '/collaborate', hint: 'Teams & invites', roles: 'all'},
  { key: 'moderation', label: 'Moderation', to: '/moderation', hint: 'Admin / Faculty', roles: ['admin', 'faculty']},
  { key: 'newsletter', label: 'Newsletter', to: '/newsletter', hint: 'Curation flow', roles: 'all'},
];

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

function mapUnseenConversationItem(item) {
  const conversationId = item?.conversationId ? String(item.conversationId) : '';
  if (!conversationId) return null;

  const unreadCount = Number(item?.unreadCount || 0);
  if (unreadCount <= 0) return null;

  const createdAt = item?.lastMessageAt || null;
  const participantLabel = item?.otherUserEmail || item?.otherUserId || 'Unknown user';

  return {
    id: `chat-${conversationId}`,
    conversationId,
    kind: 'chat',
    badge: 'DM',
    title: participantLabel,
    subtitle: `${unreadCount} unseen message${unreadCount === 1 ? '' : 's'} - ${formatRelativeTime(createdAt)}`,
    createdAt,
  };
}

function mapAnnouncementNotification(post) {
  return {
    id: `announcement-${post.id}`,
    source: 'api',
    kind: 'announcement',
    badge: 'AN',
    title: post.title || 'New announcement posted',
    subtitle: formatRelativeTime(post.createdAt),
    createdAt: post.createdAt || null,
  };
}

function mapVerificationNotification(item, isModerator) {
  const normalizedStatus = String(item?.status || '').toLowerCase();
  const createdAt = item?.reviewedAt || item?.updatedAt || item?.createdAt || null;

  if (isModerator) {
    return {
      id: `verification-${item.id}`,
      source: 'api',
      kind: 'verification',
      badge: 'VF',
      title: `${item?.applicant?.fullName || 'Alumni'} requested verification`,
      subtitle: formatRelativeTime(createdAt),
      createdAt,
    };
  }

  if (normalizedStatus === 'approved') {
    return {
      id: `verification-${item.id}`,
      source: 'api',
      kind: 'verification',
      badge: 'VF',
      title: 'Verification approved',
      subtitle: formatRelativeTime(createdAt),
      createdAt,
    };
  }

  if (normalizedStatus === 'rejected') {
    return {
      id: `verification-${item.id}`,
      source: 'api',
      kind: 'verification',
      badge: 'VF',
      title: 'Verification rejected',
      subtitle: formatRelativeTime(createdAt),
      createdAt,
    };
  }

  return {
    id: `verification-${item.id}`,
    source: 'api',
    kind: 'verification',
    badge: 'VF',
    title: 'Verification pending review',
    subtitle: formatRelativeTime(createdAt),
    createdAt,
  };
}

function mapJobNotificationItem(item) {
  return {
    id: String(item?.id || ''),
    source: 'job-service',
    kind: 'job',
    badge: 'JB',
    title: `${item?.applicantName || 'A student'} applied for ${item?.jobTitle || 'your job post'}`,
    subtitle: formatRelativeTime(item?.createdAt),
    createdAt: item?.createdAt || null,
  };
}

function mapCollabNotificationItem(item) {
  const postId = String(item?.postId || '').trim();
  const postTitle = item?.postTitle || 'a collaboration post';
  const actorName = item?.actorName || 'A collaborator';
  const eventType = String(item?.eventType || '').toLowerCase();
  let title = 'Collaboration update';

  if (eventType === 'join_request_received') {
    title = `${actorName} requested to join ${postTitle}`;
  } else if (eventType === 'join_request_accepted') {
    title = `Your request for ${postTitle} was accepted`;
  } else if (eventType === 'join_request_rejected') {
    title = `Your request for ${postTitle} was rejected`;
  }

  return {
    id: String(item?.id || ''),
    source: 'api',
    kind: 'collab',
    badge: 'CL',
    title,
    subtitle: formatRelativeTime(item?.createdAt),
    createdAt: item?.createdAt || null,
    postId,
  };
}

function SidebarItem({ item, canAccess }) {
  if (!canAccess) {
    return (
      <div className="feed-menu-item is-locked" aria-disabled="true">
        <div className="feed-menu-title-row">
          <span>{item.icon} {item.label}</span>
          <span className="mini-pill">Locked</span>
        </div>
        <small>{item.hint}</small>
      </div>
    );
  }

  return (
    <NavLink
      to={item.to}
      className={({ isActive }) => `feed-menu-item${isActive ? ' is-active' : ''}`}
      end={item.to === '/home'}
    >
      <div className="feed-menu-title-row">
        <span>{item.icon} {item.label}</span>
      </div>
      <small>{item.hint}</small>
    </NavLink>
  );
}

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAuthenticated, isModerator, clearAuthSession } = useAuth();
  const [globalSearchInput, setGlobalSearchInput] = useState('');
  const [isGlobalSearchSubmitting, setIsGlobalSearchSubmitting] = useState(false);
  const [recentUnseenMessages, setRecentUnseenMessages] = useState([]);
  const [loadingRecentUnseenMessages, setLoadingRecentUnseenMessages] = useState(true);
  const [recentNotifications, setRecentNotifications] = useState([]);
  const [loadingRecentNotifications, setLoadingRecentNotifications] = useState(true);
  const [avatarImageFailed, setAvatarImageFailed] = useState(false);

  const profileName = user?.full_name || user?.name || 'Guest User';
  const profileAvatarUrl = typeof user?.avatar_url === 'string' ? user.avatar_url.trim() : '';
  const roleLabel = user?.role ? String(user.role) : 'guest';
  const normalizedRole = String(user?.role || '').toLowerCase();
  const isAlumni = normalizedRole === 'alumni';
  const isChatRoute = location.pathname.startsWith('/chat');
  const isPublicProfileRoute = location.pathname.startsWith('/profile/');
  const isDashboardRoute = location.pathname.startsWith('/dashboard');
  const isProfileStyleRoute = isPublicProfileRoute || isDashboardRoute;
  const initials = profileName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'GU';
  const showProfileImage = Boolean(profileAvatarUrl) && !avatarImageFailed;

  function handleLogout() {
    clearAuthSession();
    navigate('/login');
  }

  function handleGlobalSearchSubmit(event) {
    event.preventDefault();
    const q = globalSearchInput.trim();

    if (!q) {
      setIsGlobalSearchSubmitting(false);
      navigate('/search');
      return;
    }

    const targetPath = `/search?q=${encodeURIComponent(q)}`;
    const currentPath = `${location.pathname}${location.search}`;
    if (targetPath === currentPath) {
      setIsGlobalSearchSubmitting(false);
      return;
    }

    setIsGlobalSearchSubmitting(true);
    navigate(targetPath);
  }

  useEffect(() => {
    setIsGlobalSearchSubmitting(false);
    if (!location.pathname.startsWith('/search')) return;
    const value = new URLSearchParams(location.search).get('q') || '';
    setGlobalSearchInput(value);
  }, [location.pathname, location.search]);

  useEffect(() => {
    setAvatarImageFailed(false);
  }, [profileAvatarUrl]);

  useEffect(() => {
    if (!isAuthenticated) {
      setRecentUnseenMessages([]);
      setLoadingRecentUnseenMessages(false);
      return undefined;
    }

    const controller = new AbortController();
    let isMounted = true;
    let isFetching = false;

    async function loadRecentUnseenMessages(showLoading = true) {
      if (isFetching) return;
      isFetching = true;
      if (showLoading) {
        setLoadingRecentUnseenMessages(true);
      }

      try {
        const conversationsResult = await apiRequest('/chat/conversations', {
          signal: controller.signal,
        });
        const conversations = Array.isArray(conversationsResult?.items)
          ? conversationsResult.items
          : (Array.isArray(conversationsResult) ? conversationsResult : []);

        const sorted = conversations
          .map(mapUnseenConversationItem)
          .filter(Boolean)
          .sort((a, b) => {
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bTime - aTime;
          })
          .slice(0, 5);

        if (!isMounted) return;
        setRecentUnseenMessages(sorted);
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.warn('Could not load unseen messages', error);
          if (isMounted) {
            setRecentUnseenMessages([]);
          }
        }
      } finally {
        if (isMounted) {
          setLoadingRecentUnseenMessages(false);
        }
        isFetching = false;
      }
    }

    loadRecentUnseenMessages(true);

    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadRecentUnseenMessages(false);
    }, 15000);

    function handleWindowFocus() {
      loadRecentUnseenMessages(false);
    }

    window.addEventListener('focus', handleWindowFocus);

    return () => {
      isMounted = false;
      controller.abort();
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [isAuthenticated, location.pathname, user?.id]);

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;
    let isFetching = false;

    async function loadRecentNotifications(showLoading = true) {
      if (isFetching) return;
      isFetching = true;
      if (showLoading) {
        setLoadingRecentNotifications(true);
      }

      try {
        const allItems = [];
        let readKeySet = new Set();
        let lastSeenMs = NaN;

        if (isAuthenticated) {
          try {
            const stateResult = await apiRequest('/users/notifications/state', {
              signal: controller.signal,
            });
            const lastSeenAt = stateResult?.data?.lastSeenAt || null;
            const readKeys = Array.isArray(stateResult?.data?.readKeys)
              ? stateResult.data.readKeys.map((value) => String(value))
              : [];
            readKeySet = new Set(readKeys);
            lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
          } catch (error) {
            if (error.name !== 'AbortError') {
              console.warn('Could not load notification read state', error);
            }
          }
        }

        try {
          const announcementsResult = await apiRequest('/posts/feed?type=ANNOUNCEMENT&status=published&limit=12&offset=0', {
            signal: controller.signal,
          });
          const announcements = Array.isArray(announcementsResult?.data) ? announcementsResult.data : [];
          allItems.push(...announcements.map(mapAnnouncementNotification));
        } catch (error) {
          if (error.name !== 'AbortError') {
            console.warn('Could not load announcement notifications', error);
          }
        }

        if (isAuthenticated && (isModerator || isAlumni)) {
          try {
            const statusParam = isModerator ? 'pending' : 'all';
            const verificationResult = await apiRequest(`/users/notifications/alumni-verifications?status=${statusParam}&limit=20`, {
              signal: controller.signal,
            });
            const items = Array.isArray(verificationResult?.data) ? verificationResult.data : [];
            allItems.push(...items.map((item) => mapVerificationNotification(item, isModerator)));
          } catch (error) {
            if (error.name !== 'AbortError') {
              console.warn('Could not load verification notifications', error);
            }
          }
        }

        if (isAuthenticated && user?.id) {
          try {
            const jobItems = await getUnreadJobApplicationNotificationsForUser(user.id, { signal: controller.signal });
            allItems.push(...jobItems.map(mapJobNotificationItem));
          } catch (error) {
            if (error.name !== 'AbortError') {
              console.warn('Could not load job notifications', error);
            }
          }
        }

        if (isAuthenticated) {
          try {
            const collabResult = await apiRequest('/posts/collab-notifications?limit=30', {
              signal: controller.signal,
            });
            const collabItems = Array.isArray(collabResult?.data) ? collabResult.data : [];
            allItems.push(...collabItems.map(mapCollabNotificationItem));
          } catch (error) {
            if (error.name !== 'AbortError') {
              console.warn('Could not load collaboration notifications', error);
            }
          }
        }

        if (!isMounted) return;

        const sorted = allItems
          .slice()
          .sort((a, b) => {
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bTime - aTime;
          });

        const unreadFiltered = sorted.filter((item) => {
          if (!isAuthenticated) return true;
          if (item.source === 'job-service') return true;
          if (readKeySet.has(String(item.id))) return false;
          if (!item.createdAt) return true;
          const createdAtMs = new Date(item.createdAt).getTime();
          if (Number.isNaN(createdAtMs)) return true;
          if (Number.isNaN(lastSeenMs)) return true;
          return createdAtMs > lastSeenMs;
        });

        setRecentNotifications(unreadFiltered.slice(0, 5));
      } finally {
        if (isMounted) {
          setLoadingRecentNotifications(false);
        }
        isFetching = false;
      }
    }

    loadRecentNotifications(true);

    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadRecentNotifications(false);
    }, 20000);

    function handleWindowFocus() {
      loadRecentNotifications(false);
    }

    window.addEventListener('focus', handleWindowFocus);

    return () => {
      isMounted = false;
      controller.abort();
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [isAuthenticated, isModerator, isAlumni, location.pathname, user?.id]);

  return (
    <div className="social-shell">
      <header className="social-topbar">
        <div className="topbar-left">
          <Link className="brand-badge topbar-brand-link" to="/home" aria-label="Go to homepage">
            IC
          </Link>
          <form className="topbar-search" onSubmit={handleGlobalSearchSubmit} role="search" aria-label="Search posts">
            <span className="topbar-search-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M10 3a7 7 0 1 1 0 14a7 7 0 0 1 0-14zm0 2a5 5 0 1 0 .001 10.001A5 5 0 0 0 10 5zm8.707 11.293l2 2a1 1 0 0 1-1.414 1.414l-2-2a1 1 0 0 1 1.414-1.414z" />
              </svg>
            </span>
            <input
              id="global-search"
              type="search"
              placeholder="Search posts..."
              value={globalSearchInput}
              onChange={(event) => setGlobalSearchInput(event.target.value)}
              autoComplete="off"
            />
            <button
              type="submit"
              className="topbar-search-submit"
              aria-label="Search"
              disabled={isGlobalSearchSubmitting}
            >
              {isGlobalSearchSubmitting ? (
                <span className="topbar-search-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
                  <path d="M10 3a7 7 0 1 1 0 14a7 7 0 0 1 0-14zm0 2a5 5 0 1 0 .001 10.001A5 5 0 0 0 10 5zm8.707 11.293l2 2a1 1 0 0 1-1.414 1.414l-2-2a1 1 0 0 1 1.414-1.414z" />
                </svg>
              )}
            </button>
          </form>
        </div>

        <nav className="topbar-nav" aria-label="Primary">
          <NavLink to="/home" className={({ isActive }) => `topbar-nav-link${isActive ? ' is-active' : ''}`}>HOME</NavLink>
          <NavLink to="/job-portal" className={({ isActive }) => `topbar-nav-link${isActive ? ' is-active' : ''}`}>JOBS</NavLink>
          <NavLink to="/collaborate" className={({ isActive }) => `topbar-nav-link${isActive ? ' is-active' : ''}`}>COLLAB</NavLink>
          <NavLink to="/events" className={({ isActive }) => `topbar-nav-link${isActive ? ' is-active' : ''}`}>EVENTS</NavLink>
        </nav>

        <div className="social-topbar-actions topbar-right">
          <button
            type="button"
            className="topbar-circle-btn"
            aria-label="Chat"
            onClick={() => navigate('/chat')}
          >
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H10l-4.1 3.5c-.65.55-1.9.13-1.9-.74V16.7A2.5 2.5 0 0 1 4 13.5v-8z" />
            </svg>
          </button>

          <button
            type="button"
            className="topbar-circle-btn topbar-notif-btn"
            aria-label="Notifications"
            onClick={() => navigate('/notifications')}
          >
            <span className="notif-dot" />
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M12 3a5 5 0 0 0-5 5v2.25c0 .95-.32 1.88-.92 2.62l-.9 1.13A1.5 1.5 0 0 0 6.35 16.5h11.3a1.5 1.5 0 0 0 1.17-2.5l-.9-1.13A4.22 4.22 0 0 1 17 10.25V8a5 5 0 0 0-5-5zm0 18a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 21z" />
            </svg>
          </button>

          <button type="button" className="profile-btn" aria-label="Profile" onClick={() => navigate('/dashboard')}>
            <span className={`avatar-badge${showProfileImage ? ' has-image' : ''}`} aria-hidden="true">
              {showProfileImage ? (
                <img
                  src={profileAvatarUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onError={() => setAvatarImageFailed(true)}
                />
              ) : (
                <span className="avatar-fallback">{initials}</span>
              )}
            </span>
            <span className="profile-meta">
              <strong>{profileName}</strong>
              <small>{roleLabel}</small>
            </span>
          </button>

          {isAuthenticated ? (
            <button type="button" className="btn btn-soft logout-mini-btn" onClick={handleLogout}>
              Log out
            </button>
          ) : (
            <div className="auth-inline-links">
              <NavLink to="/login" className="btn btn-soft">Login</NavLink>
              <NavLink to="/signup" className="btn btn-accent">Signup</NavLink>
            </div>
          )}
        </div>
      </header>

      <div className={`social-layout${isChatRoute ? ' is-chat-route' : ''}${isProfileStyleRoute ? ' is-profile-route' : ''}`}>
        {!isChatRoute && !isProfileStyleRoute ? (
          <aside className="feed-sidebar feed-sidebar-left" aria-label="Feed sections">
            <section className="panel sidebar-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Explore</p>
                  <h3>Menu</h3>
                </div>
              </div>

              <nav className="feed-menu-list">
                {FEED_SECTIONS.map((item) => {
                  const canAccess = item.roles === 'all' || (Array.isArray(item.roles) && isModerator);
                  return <SidebarItem key={item.key} item={item} canAccess={canAccess} />;
                })}
              </nav>
            </section>
          </aside>
        ) : null}

        <main className={`social-main-content${isChatRoute ? ' is-chat-layout' : ''}${isProfileStyleRoute ? ' is-profile-layout' : ''}`}>
          <Outlet />
        </main>

        {!isChatRoute && !isProfileStyleRoute ? (
          <aside className="feed-sidebar feed-sidebar-right" aria-label="Social sidebar">
            <section className="panel sidebar-panel compact-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Messages</p>
                  <h3>Recent unseen</h3>
                </div>
              </div>

              <div className="contact-list">
                {loadingRecentUnseenMessages ? (
                  <div className="contact-item">
                    <span className="contact-avatar contact-avatar-group" aria-hidden="true">..</span>
                    <div>
                      <strong>Loading unseen messages</strong>
                      <small>Fetching latest updates</small>
                    </div>
                  </div>
                ) : recentUnseenMessages.length === 0 ? (
                  <div className="contact-item">
                    <span className="contact-avatar contact-avatar-group" aria-hidden="true">DM</span>
                    <div>
                      <strong>No unseen messages</strong>
                      <small>You're all caught up</small>
                    </div>
                  </div>
                ) : (
                  recentUnseenMessages.map((item) => (
                    <button
                      type="button"
                      className={`contact-item contact-item-action notif-${item.kind || 'neutral'}`}
                      key={item.id}
                      onClick={() => navigate('/chat', { state: { preferredConversationId: item.conversationId } })}
                    >
                      <span className="contact-avatar contact-avatar-group" aria-hidden="true">{item.badge}</span>
                      <div>
                        <strong>{item.title}</strong>
                        <small>{item.subtitle}</small>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="panel sidebar-panel compact-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Notifications</p>
                  <h3>Recent</h3>
                </div>
              </div>

              <div className="contact-list">
                {loadingRecentNotifications ? (
                  <div className="contact-item">
                    <span className="contact-avatar contact-avatar-group" aria-hidden="true">..</span>
                    <div>
                      <strong>Loading notifications</strong>
                      <small>Fetching latest updates</small>
                    </div>
                  </div>
                ) : recentNotifications.length === 0 ? (
                  <div className="contact-item">
                    <span className="contact-avatar contact-avatar-group" aria-hidden="true">NA</span>
                    <div>
                      <strong>No recent notifications</strong>
                      <small>You're all caught up</small>
                    </div>
                  </div>
                ) : (
                  recentNotifications.map((item) => (
                    <button
                      type="button"
                      className={`contact-item contact-item-action notif-${item.kind || 'neutral'}`}
                      key={item.id}
                      onClick={() => navigate('/notifications')}
                    >
                      <span className="contact-avatar contact-avatar-group" aria-hidden="true">{item.badge}</span>
                      <div>
                        <strong>{item.title}</strong>
                        <small>{item.subtitle}</small>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
