import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PostResultCard from '../components/posts/PostResultCard';
import { useAuth } from '../context/useAuth';
import { fetchPublicUserProfile, fetchUserPosts } from '../utils/profileApi';

const PROFILE_SORT_OPTIONS = [
  { value: 'new', label: 'Newest' },
  { value: 'upvotes', label: 'Most upvoted' },
];

function safeText(value, fallback = '') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

function getInitials(value) {
  const parts = String(value || '')
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);

  if (!parts.length) return 'U';
  return parts.map((part) => part[0]?.toUpperCase() || '').join('') || 'U';
}

export default function ProfilePage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const currentUserId = String(user?.id || '').trim();
  const targetUserId = String(userId || '').trim();

  const [profile, setProfile] = useState(null);
  const [posts, setPosts] = useState([]);
  const [sort, setSort] = useState('new');
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [pageError, setPageError] = useState('');
  const [banner, setBanner] = useState({ type: 'idle', message: '' });

  useEffect(() => {
    if (!targetUserId) return;
    if (currentUserId && targetUserId === currentUserId) {
      navigate('/dashboard', { replace: true });
    }
  }, [currentUserId, navigate, targetUserId]);

  useEffect(() => {
    if (!targetUserId) {
      setLoadingProfile(false);
      setPageError('User id is missing.');
      return;
    }

    let isMounted = true;
    async function loadProfile() {
      setLoadingProfile(true);
      setPageError('');
      try {
        const profileResult = await fetchPublicUserProfile(targetUserId);
        if (!isMounted) return;
        setProfile(profileResult);
      } catch (error) {
        if (!isMounted) return;
        setPageError(error.message || 'Could not load profile.');
      } finally {
        if (isMounted) setLoadingProfile(false);
      }
    }

    loadProfile();
    return () => {
      isMounted = false;
    };
  }, [targetUserId]);

  useEffect(() => {
    if (!targetUserId) return;
    let isMounted = true;

    async function loadPosts() {
      setLoadingPosts(true);
      try {
        const result = await fetchUserPosts({
          authorId: targetUserId,
          sort,
          status: 'published',
          limit: 120,
        });
        if (!isMounted) return;
        setPosts(result.items);
      } catch (error) {
        if (!isMounted) return;
        setPageError(error.message || 'Could not load posts.');
      } finally {
        if (isMounted) setLoadingPosts(false);
      }
    }

    loadPosts();
    return () => {
      isMounted = false;
    };
  }, [sort, targetUserId]);

  const displayName = safeText(profile?.fullName) || 'Community member';
  const avatarUrl = safeText(profile?.avatarUrl);
  const bioText = safeText(profile?.bio);
  const highlights = [safeText(profile?.location), safeText(profile?.education), safeText(profile?.work)].filter(Boolean);
  const visibleDetails = useMemo(() => ([
    { label: 'Bio', value: safeText(profile?.bio) },
    { label: 'Location', value: safeText(profile?.location) },
    { label: 'Education', value: safeText(profile?.education) },
    { label: 'Work', value: safeText(profile?.work) },
  ].filter((item) => item.value)), [profile]);

  const pageLoading = loadingProfile || loadingPosts;

  function handlePostUpdated(postId, patch) {
    setPosts((prev) => prev.map((item) => (item.id === postId ? { ...item, ...patch } : item)));
  }

  function handlePostDeleted(postId) {
    setPosts((prev) => prev.filter((item) => item.id !== postId));
  }

  return (
    <div className="dashboard-page profile-page-shell public-profile-page">
      {banner.message && (
        <section className={`banner banner-${banner.type === 'error' ? 'error' : 'success'}`} aria-live="polite">
          <p>{banner.message}</p>
          <button type="button" onClick={() => setBanner({ type: 'idle', message: '' })}>Dismiss</button>
        </section>
      )}

      {pageError && (
        <section className="inline-alert" role="alert">
          <p>{pageError}</p>
        </section>
      )}

      <section className="panel profile-hero-panel">
        <div className="profile-cover-block" aria-hidden="true" />
        <div className="profile-hero-content">
          <div className="profile-hero-avatar">
            {avatarUrl ? <img src={avatarUrl} alt={`${displayName} avatar`} /> : <span>{getInitials(displayName)}</span>}
          </div>

          <div className="profile-hero-text">
            <h1>{displayName}</h1>
            {highlights.length > 0 ? (
              <div className="profile-public-subline">
                {highlights.map((item) => <span key={item}>{item}</span>)}
              </div>
            ) : (
              <p className="profile-muted-line">No public details shared yet.</p>
            )}
            {bioText && <p className="profile-public-bio">{bioText}</p>}
          </div>
        </div>
      </section>

      <div className="profile-layout-grid">
        <section className="panel profile-personal-card">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Profile</p>
              <h3>Personal details</h3>
            </div>
          </div>

          {loadingProfile ? (
            <p className="post-comments-hint">Loading details...</p>
          ) : visibleDetails.length === 0 ? (
            <p className="profile-muted-line">No public details available.</p>
          ) : (
            <div className="profile-detail-list">
              {visibleDetails.map((item) => (
                <article key={item.label}>
                  <h4>{item.label}</h4>
                  <p>{item.value}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel profile-posts-panel">
          <div className="panel-header profile-posts-head">
            <div>
              <p className="eyebrow">Posts</p>
              <h3>Recent posts</h3>
            </div>
            <label className="profile-sort-control">
              <span>Sort</span>
              <select value={sort} onChange={(event) => setSort(event.target.value)}>
                {PROFILE_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          {pageLoading ? (
            <p className="post-comments-hint">Loading posts...</p>
          ) : posts.length === 0 ? (
            <div className="empty-state">
              <h4>No posts yet</h4>
              <p>This user has not published posts yet.</p>
            </div>
          ) : (
            <div className="feed-grid profile-post-grid">
              {posts.map((item, index) => (
                <PostResultCard
                  key={item.id || `profile-post-${index}`}
                  post={item}
                  index={index}
                  onPostUpdated={handlePostUpdated}
                  onPostDeleted={handlePostDeleted}
                  onActionFeedback={setBanner}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
