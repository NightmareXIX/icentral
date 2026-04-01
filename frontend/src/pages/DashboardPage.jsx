import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PostResultCard from '../components/posts/PostResultCard';
import { useAuth } from '../context/useAuth';
import {
  apiRequest,
  fetchCurrentUserProfile,
  fetchUserPosts,
  updateCurrentUserAvatar,
  updateCurrentUserProfile,
} from '../utils/profileApi';

const EDITABLE_VISIBILITY_FIELDS = ['bio', 'location', 'education', 'work'];
const VISIBILITY_LABELS = {
  bio: 'Bio',
  location: 'Location',
  education: 'Education',
  work: 'Work',
};
const DEFAULT_VISIBILITY = {
  bio: true,
  location: true,
  education: true,
  work: true,
};
const PROFILE_SORT_OPTIONS = [
  { value: 'new', label: 'Newest' },
  { value: 'upvotes', label: 'Most upvoted' },
];
const COMPOSER_TYPE_OPTIONS = [
  { value: 'GENERAL', label: 'General' },
  { value: 'ANNOUNCEMENT', label: 'Announcement' },
  { value: 'JOB', label: 'Job' },
  { value: 'EVENT', label: 'Event' },
  { value: 'EVENT_RECAP', label: 'Event Recap' },
  { value: 'ACHIEVEMENT', label: 'Achievement' },
  { value: 'COLLAB', label: 'Collaboration' },
];
const INITIAL_COMPOSER_FORM = {
  type: 'GENERAL',
  title: '',
  summary: '',
  status: 'published',
  tagIds: [],
  pinned: false,
  expiresAt: '',
};

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

function getInitials(value) {
  const parts = String(value || '')
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) return 'U';
  return parts.map((part) => part[0]?.toUpperCase() || '').join('') || 'U';
}

function safeText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function normalizeVisibility(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_VISIBILITY };
  return {
    bio: value.bio !== false,
    location: value.location !== false,
    education: value.education !== false,
    work: value.work !== false,
  };
}

function toEditForm(profile) {
  return {
    fullName: safeText(profile?.fullName),
    bio: safeText(profile?.bio),
    location: safeText(profile?.location),
    education: safeText(profile?.education),
    work: safeText(profile?.work),
    visibility: normalizeVisibility(profile?.visibility),
  };
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { isAuthenticated, user, token, setAuthSession } = useAuth();
  const avatarFileInputRef = useRef(null);
  const composerImageInputRef = useRef(null);

  const currentUserId = String(user?.id || '').trim();
  const normalizedRole = String(user?.role || '').toLowerCase();

  const [profile, setProfile] = useState(null);
  const [posts, setPosts] = useState([]);
  const [sort, setSort] = useState('new');
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [pageError, setPageError] = useState('');
  const [banner, setBanner] = useState({ type: 'idle', message: '' });

  const [composerForm, setComposerForm] = useState(INITIAL_COMPOSER_FORM);
  const [submittingPost, setSubmittingPost] = useState(false);
  const [tags, setTags] = useState([]);
  const [tagSearchInput, setTagSearchInput] = useState('');
  const [composerImage, setComposerImage] = useState(null);

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState(toEditForm(null));
  const [editAvatarFile, setEditAvatarFile] = useState(null);
  const [editAvatarUrl, setEditAvatarUrl] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const allowedComposerTypeOptions = useMemo(
    () => COMPOSER_TYPE_OPTIONS.filter((option) => canRoleCreateType(normalizedRole, option.value)),
    [normalizedRole],
  );
  const composerAvatar = String(user?.full_name || user?.name || user?.email || 'G').trim().charAt(0).toUpperCase() || 'G';
  const composerSelectedTagIds = Array.isArray(composerForm.tagIds)
    ? composerForm.tagIds.map((value) => String(value)).filter(Boolean)
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

  const displayName = safeText(profile?.fullName) || safeText(user?.full_name) || safeText(user?.name) || 'User';
  const avatarUrl = safeText(profile?.avatarUrl);
  const profileInitials = getInitials(displayName);
  const visibility = normalizeVisibility(profile?.visibility);
  const headerDetails = [
    visibility.location ? safeText(profile?.location) : '',
    visibility.education ? safeText(profile?.education) : '',
    visibility.work ? safeText(profile?.work) : '',
  ].filter(Boolean);

  function syncAuthUser(nextProfile) {
    if (!token || !user || !nextProfile) return;

    const nextFullName = safeText(nextProfile.fullName) || safeText(user.full_name);
    const nextAvatarUrl = safeText(nextProfile.avatarUrl);
    const previousAvatarUrl = safeText(user.avatar_url);

    if (nextFullName === safeText(user.full_name) && nextAvatarUrl === previousAvatarUrl) {
      return;
    }

    setAuthSession({
      token,
      user: {
        ...user,
        full_name: nextFullName || user.full_name || user.name,
        avatar_url: nextAvatarUrl || null,
      },
    });
  }

  async function loadProfile() {
    setLoadingProfile(true);
    setPageError('');
    try {
      const profileResult = await fetchCurrentUserProfile();
      setProfile(profileResult);
      syncAuthUser(profileResult);
    } catch (error) {
      setPageError(error.message || 'Could not load your profile.');
    } finally {
      setLoadingProfile(false);
    }
  }

  async function loadPosts(activeSort) {
    if (!currentUserId) return;

    setLoadingPosts(true);
    try {
      const result = await fetchUserPosts({
        authorId: currentUserId,
        sort: activeSort,
        status: 'all',
        limit: 120,
      });
      setPosts(result.items);
    } catch (error) {
      setBanner({ type: 'error', message: `Could not load posts: ${error.message}` });
    } finally {
      setLoadingPosts(false);
    }
  }

  useEffect(() => {
    if (isAuthenticated) return;
    navigate('/login', { replace: true });
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    if (!isAuthenticated || !currentUserId) return;
    loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, currentUserId]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let isMounted = true;

    async function loadTags() {
      try {
        const result = await apiRequest('/posts/tags');
        if (!isMounted) return;
        setTags(Array.isArray(result?.data) ? result.data : []);
      } catch (error) {
        if (!isMounted) return;
        setBanner({ type: 'error', message: `Failed to load tags: ${error.message}` });
      }
    }

    loadTags();
    return () => {
      isMounted = false;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!allowedComposerTypeOptions.some((option) => option.value === composerForm.type)) {
      setComposerForm((prev) => ({
        ...prev,
        type: allowedComposerTypeOptions.find((option) => option.value === 'GENERAL')?.value
          || allowedComposerTypeOptions[0]?.value
          || 'GENERAL',
      }));
    }
  }, [allowedComposerTypeOptions, composerForm.type]);

  useEffect(() => {
    if (!isAuthenticated || !currentUserId) return;
    loadPosts(sort);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, currentUserId, sort]);

  function openEditProfileModal() {
    setEditForm(toEditForm(profile));
    setEditAvatarFile(null);
    setEditAvatarUrl('');
    setIsEditOpen(true);
  }

  function closeEditProfileModal() {
    if (savingProfile) return;
    setIsEditOpen(false);
  }

  function updateComposerField(field, value) {
    setComposerForm((prev) => ({ ...prev, [field]: value }));
  }

  function addTagToComposer(tagId) {
    updateComposerField('tagIds', [...new Set([...composerSelectedTagIds, String(tagId)])]);
    setTagSearchInput('');
  }

  function removeTagFromComposer(tagId) {
    updateComposerField('tagIds', composerSelectedTagIds.filter((id) => id !== String(tagId)));
  }

  function openImagePicker() {
    composerImageInputRef.current?.click();
  }

  function clearComposerImage() {
    setComposerImage(null);
    if (composerImageInputRef.current) composerImageInputRef.current.value = '';
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

    const summary = safeText(composerForm.summary);

    if (!composerForm.type || !summary) {
      setBanner({ type: 'error', message: 'Type and summary are required to create a post.' });
      return;
    }

    if (!canRoleCreateType(normalizedRole, composerForm.type)) {
      setBanner({ type: 'error', message: getRoleTypeBlockMessage(normalizedRole, composerForm.type) });
      return;
    }

    const maybeAuthorId = user?.id && /^[0-9a-fA-F-]{32,36}$/.test(String(user.id)) ? user.id : undefined;
    const payload = {
      type: composerForm.type,
      title: safeText(composerForm.title) || null,
      summary,
      status: composerForm.status,
      pinned: Boolean(composerForm.pinned),
      tags: [...new Set(composerSelectedTagIds)],
      expiresAt: safeText(composerForm.expiresAt) || null,
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
      setComposerForm(INITIAL_COMPOSER_FORM);
      setTagSearchInput('');
      clearComposerImage();
      setBanner({ type: 'success', message: 'Post created and added to your feed.' });
      await loadPosts(sort);
    } catch (error) {
      setBanner({ type: 'error', message: `Could not create post: ${error.message}` });
    } finally {
      setSubmittingPost(false);
    }
  }

  async function handleSaveProfile(event) {
    event.preventDefault();
    setSavingProfile(true);

    try {
      let latestProfile = profile;
      let avatarUpdateError = '';

      if (editAvatarFile) {
        try {
          latestProfile = await updateCurrentUserAvatar({ file: editAvatarFile });
        } catch (error) {
          avatarUpdateError = error.message || 'Could not update avatar.';
        }
      } else if (safeText(editAvatarUrl)) {
        try {
          latestProfile = await updateCurrentUserAvatar({ avatarUrl: safeText(editAvatarUrl) });
        } catch (error) {
          avatarUpdateError = error.message || 'Could not update avatar.';
        }
      }

      const updatedProfile = await updateCurrentUserProfile({
        fullName: safeText(editForm.fullName),
        bio: safeText(editForm.bio),
        location: safeText(editForm.location),
        education: safeText(editForm.education),
        work: safeText(editForm.work),
        visibility: editForm.visibility,
      });

      const finalProfile = updatedProfile || latestProfile;
      setProfile(finalProfile);
      syncAuthUser(finalProfile);
      setBanner({
        type: 'success',
        message: avatarUpdateError
          ? `Profile updated. Avatar not changed: ${avatarUpdateError}`
          : 'Profile updated.',
      });
      setIsEditOpen(false);
    } catch (error) {
      setBanner({ type: 'error', message: `Could not update profile: ${error.message}` });
    } finally {
      setSavingProfile(false);
    }
  }

  const pageReady = !loadingProfile && !loadingPosts;

  function handlePostUpdated(postId, patch) {
    setPosts((prev) => prev.map((item) => (item.id === postId ? { ...item, ...patch } : item)));
  }

  function handlePostDeleted(postId) {
    setPosts((prev) => prev.filter((item) => item.id !== postId));
  }

  return (
    <div className="dashboard-page profile-page-shell">
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
          <button
            type="button"
            className="profile-hero-avatar profile-avatar-action"
            onClick={openEditProfileModal}
            aria-label="Edit profile photo"
          >
            {avatarUrl ? <img src={avatarUrl} alt={`${displayName} avatar`} /> : <span>{profileInitials}</span>}
          </button>

          <div className="profile-hero-text">
            <h1>{displayName}</h1>
            {headerDetails.length > 0 ? (
              <div className="profile-highlights">
                {headerDetails.map((detail) => (
                  <span key={detail}>{detail}</span>
                ))}
              </div>
            ) : (
              <p className="profile-muted-line">Add details from Edit profile to complete this header.</p>
            )}
          </div>

          <div className="profile-hero-actions">
            <button type="button" className="btn btn-soft" onClick={openEditProfileModal}>
              Edit profile
            </button>
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

          <div className="profile-detail-list">
            <article>
              <h4>Name</h4>
              <p>{displayName}</p>
            </article>
            <article>
              <h4>Bio</h4>
              <p>{safeText(profile?.bio) || 'Not provided'}</p>
              <small>{visibility.bio ? 'Visible' : 'Hidden from others'}</small>
            </article>
            <article>
              <h4>Location</h4>
              <p>{safeText(profile?.location) || 'Not provided'}</p>
              <small>{visibility.location ? 'Visible' : 'Hidden from others'}</small>
            </article>
            <article>
              <h4>Education</h4>
              <p>{safeText(profile?.education) || 'Not provided'}</p>
              <small>{visibility.education ? 'Visible' : 'Hidden from others'}</small>
            </article>
            <article>
              <h4>Work</h4>
              <p>{safeText(profile?.work) || 'Not provided'}</p>
              <small>{visibility.work ? 'Visible' : 'Hidden from others'}</small>
            </article>
          </div>
        </section>

        <section className="profile-main-column">
          <section className="panel profile-create-post-card composer-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Create</p>
                <h3>New Feed Post</h3>
              </div>
            </div>

            <form className="composer-horizontal-form" onSubmit={handleCreatePost}>
              <div className="composer-quick-row">
                <span className="composer-avatar-badge" aria-hidden="true">{composerAvatar}</span>

                <label className="sr-only" htmlFor="dashboard-post-summary">Summary</label>
                <input
                  id="dashboard-post-summary"
                  className="composer-summary-input"
                  type="text"
                  placeholder={isAuthenticated ? "What's on your mind?" : 'Sign in to write a post summary'}
                  value={composerForm.summary}
                  onChange={(event) => updateComposerField('summary', event.target.value)}
                  disabled={!isAuthenticated}
                />

                <div className="composer-action-row">
                  <input
                    ref={composerImageInputRef}
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
                  <select
                    value={composerForm.type}
                    onChange={(event) => updateComposerField('type', event.target.value)}
                    disabled={!isAuthenticated}
                  >
                    {allowedComposerTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <label className="composer-field field-status">
                  <span>Status</span>
                  <select
                    value={composerForm.status}
                    onChange={(event) => updateComposerField('status', event.target.value)}
                    disabled={!isAuthenticated}
                  >
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
                    value={composerForm.title}
                    onChange={(event) => updateComposerField('title', event.target.value)}
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
                      onChange={(event) => setTagSearchInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        if (!normalizedTagQuery || filteredTagResults.length === 0) return;
                        event.preventDefault();
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
                    value={composerForm.expiresAt}
                    onChange={(event) => updateComposerField('expiresAt', event.target.value)}
                    disabled={!isAuthenticated}
                  />
                </label>
              </div>
            </form>
          </section>

          <section className="panel profile-posts-panel">
            <div className="panel-header profile-posts-head">
              <div>
                <p className="eyebrow">Posts</p>
                <h3>Your posts</h3>
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

            {!pageReady ? (
              <p className="post-comments-hint">Loading profile data...</p>
            ) : loadingPosts ? (
              <p className="post-comments-hint">Loading posts...</p>
            ) : posts.length === 0 ? (
              <div className="empty-state">
                <h4>No posts yet</h4>
                <p>Create your first post from the card above.</p>
              </div>
            ) : (
              <div className="feed-grid profile-post-grid">
                {posts.map((item, index) => (
                  <PostResultCard
                    key={item.id || `dashboard-post-${index}`}
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
        </section>
      </div>

      {isEditOpen && (
        <div className="profile-edit-backdrop" role="dialog" aria-modal="true" aria-label="Edit profile">
          <section className="panel profile-edit-modal">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Profile</p>
                <h3>Edit profile</h3>
              </div>
              <button type="button" className="btn btn-soft" onClick={closeEditProfileModal} disabled={savingProfile}>
                Close
              </button>
            </div>

            <form className="profile-edit-form" onSubmit={handleSaveProfile}>
              <section className="profile-edit-section profile-edit-avatar-section">
                <button
                  type="button"
                  className="profile-hero-avatar profile-avatar-action profile-edit-avatar-preview"
                  onClick={() => avatarFileInputRef.current?.click()}
                  aria-label="Upload avatar"
                >
                  {editAvatarFile ? (
                    <span>{getInitials(editAvatarFile.name)}</span>
                  ) : avatarUrl ? (
                    <img src={avatarUrl} alt={`${displayName} avatar`} />
                  ) : (
                    <span>{profileInitials}</span>
                  )}
                </button>

                <div className="profile-edit-avatar-controls">
                  <div className="profile-edit-upload-row">
                    <input
                      ref={avatarFileInputRef}
                      className="profile-edit-file-input"
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        const [file] = Array.from(event.target.files || []);
                        if (!file) {
                          setEditAvatarFile(null);
                          return;
                        }
                        setEditAvatarFile(file);
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-soft"
                      onClick={() => avatarFileInputRef.current?.click()}
                    >
                      {editAvatarFile ? 'Replace photo' : 'Upload photo'}
                    </button>
                    {editAvatarFile && (
                      <button type="button" className="btn btn-soft" onClick={() => setEditAvatarFile(null)}>
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="profile-edit-upload-hint">
                    {editAvatarFile ? `Selected: ${editAvatarFile.name}` : 'No file selected'}
                  </p>
                  <label>
                    <span>Avatar URL (fallback)</span>
                    <input
                      type="url"
                      placeholder="https://example.com/avatar.jpg"
                      value={editAvatarUrl}
                      onChange={(event) => setEditAvatarUrl(event.target.value)}
                    />
                  </label>
                </div>
              </section>

              <section className="profile-edit-section">
                <div className="profile-edit-section-head">
                  <h4>Basic information</h4>
                  <p>Update how your profile appears on dashboard and public profile.</p>
                </div>

                <div className="profile-edit-grid">
                  <label className="profile-edit-field-wide">
                    <span>Name</span>
                    <input
                      type="text"
                      value={editForm.fullName}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, fullName: event.target.value }))}
                      required
                    />
                  </label>

                  <label className="profile-edit-field-wide">
                    <span>Bio</span>
                    <textarea
                      rows={3}
                      value={editForm.bio}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, bio: event.target.value }))}
                    />
                  </label>

                  <label>
                    <span>Location</span>
                    <input
                      type="text"
                      value={editForm.location}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, location: event.target.value }))}
                    />
                  </label>

                  <label>
                    <span>Education</span>
                    <input
                      type="text"
                      value={editForm.education}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, education: event.target.value }))}
                    />
                  </label>

                  <label className="profile-edit-field-wide">
                    <span>Work</span>
                    <input
                      type="text"
                      value={editForm.work}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, work: event.target.value }))}
                    />
                  </label>
                </div>
              </section>

              <section className="profile-edit-section">
                <div className="profile-edit-section-head">
                  <h4>Visibility</h4>
                  <p>Choose which details other users can see on your public profile.</p>
                </div>
                <div className="profile-visibility-grid profile-visibility-grid-enhanced">
                  {EDITABLE_VISIBILITY_FIELDS.map((field) => {
                    const checked = Boolean(editForm.visibility[field]);
                    return (
                      <label key={field} className="profile-visibility-toggle">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => setEditForm((prev) => ({
                            ...prev,
                            visibility: {
                              ...prev.visibility,
                              [field]: event.target.checked,
                            },
                          }))}
                        />
                        <span className="profile-visibility-copy">
                          <strong>{VISIBILITY_LABELS[field] || field}</strong>
                          <small>{checked ? 'Visible to others' : 'Hidden from others'}</small>
                        </span>
                        <span className="profile-visibility-switch" aria-hidden="true" />
                      </label>
                    );
                  })}
                </div>
              </section>

              <div className="profile-edit-actions">
                <button type="button" className="btn btn-soft" onClick={closeEditProfileModal} disabled={savingProfile}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary-solid" disabled={savingProfile}>
                  {savingProfile ? 'Saving...' : 'Save changes'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
