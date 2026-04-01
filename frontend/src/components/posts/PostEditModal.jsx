import { useEffect, useMemo, useState } from 'react';
import { getEventMetadata } from '../../utils/eventPost';
import {
  getPostImageRef,
  updatePostById,
} from '../../utils/postManagement';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createEntityId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}`;
}

function toDateTimeLocalValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function localDateTimeToIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function uniqueCommaSeparatedValues(value) {
  const seen = new Set();
  const result = [];

  for (const part of String(value || '').split(',')) {
    const normalized = normalizeText(part);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function getPostVariant(post) {
  const type = String(post?.type || '').trim().toUpperCase();
  if (type === 'JOB') return 'job';
  if (type === 'EVENT' || type === 'EVENT_RECAP') return 'event';
  return 'generic';
}

function getJobRef(post) {
  if (!Array.isArray(post?.refs)) return null;
  return post.refs.find((ref) => String(ref?.service || '').trim().toLowerCase() === 'job-details') || null;
}

function getEventRef(post) {
  if (!Array.isArray(post?.refs)) return null;
  return post.refs.find((ref) => String(ref?.service || '').trim().toLowerCase() === 'event-details') || null;
}

function getRawJobValues(post) {
  const jobRef = getJobRef(post);
  const metadata = jobRef?.metadata && typeof jobRef.metadata === 'object'
    ? jobRef.metadata
    : {};

  return {
    jobTitle: normalizeText(metadata.jobTitle) || normalizeText(post?.title),
    companyName: normalizeText(metadata.companyName),
    jobDescription: normalizeText(metadata.jobDescription) || normalizeText(post?.summary),
    salaryRange: normalizeText(metadata.salaryRange),
  };
}

function buildInitialForm(post) {
  const variant = getPostVariant(post);
  const imageRef = getPostImageRef(post);
  const eventMetadata = variant === 'event' ? getEventMetadata(post) : null;
  const jobDetails = variant === 'job' ? getRawJobValues(post) : null;

  return {
    title: normalizeText(post?.title),
    summary: normalizeText(post?.summary),
    tags: Array.isArray(post?.tags)
      ? post.tags
        .map((tag) => normalizeText(typeof tag === 'string' ? tag : tag?.name || tag?.slug))
        .filter(Boolean)
        .join(', ')
      : '',
    expiresAt: toDateTimeLocalValue(post?.expiresAt),
    imagePreview: imageRef?.metadata?.imageDataUrl || '',
    imageFileName: normalizeText(imageRef?.metadata?.fileName) || '',
    imageFileType: normalizeText(imageRef?.metadata?.fileType) || '',
    imageFileSize: Number.isFinite(Number(imageRef?.metadata?.fileSize))
      ? Number(imageRef.metadata.fileSize)
      : 0,
    imageEntityId: normalizeText(imageRef?.entityId) || createEntityId('image-upload'),
    imageChanged: false,
    jobTitle: normalizeText(jobDetails?.jobTitle),
    companyName: normalizeText(jobDetails?.companyName),
    jobDescription: normalizeText(jobDetails?.jobDescription),
    salaryRange: normalizeText(jobDetails?.salaryRange),
    startsAt: toDateTimeLocalValue(eventMetadata?.startsAt),
    endsAt: toDateTimeLocalValue(eventMetadata?.endsAt),
    location: normalizeText(eventMetadata?.location),
    rules: Array.isArray(eventMetadata?.rules) ? eventMetadata.rules.join('\n') : '',
    contactInfo: normalizeText(eventMetadata?.contactInfo),
    rsvpUrl: normalizeText(eventMetadata?.rsvpUrl),
    organizerNotes: normalizeText(eventMetadata?.organizerNotes),
  };
}

function getSuccessMessage(variant) {
  if (variant === 'job') return 'Job post updated.';
  if (variant === 'event') return 'Event post updated.';
  return 'Post updated.';
}

function getFailureMessage(variant, error) {
  if (variant === 'job') return `Could not update job post: ${error.message}`;
  if (variant === 'event') return `Could not update event post: ${error.message}`;
  return `Could not update post: ${error.message}`;
}

async function readImageFile(file) {
  const maxBytes = 900 * 1024;
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are supported.');
  }
  if (file.size > maxBytes) {
    throw new Error('Image is too large. Please choose one under 900 KB.');
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => reject(new Error('Failed to load selected image.'));
    reader.readAsDataURL(file);
  });

  if (!dataUrl) {
    throw new Error('Could not read the selected image.');
  }

  return {
    dataUrl,
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
  };
}

export default function PostEditModal({
  open,
  post,
  onClose,
  onSaved,
  onFeedback,
}) {
  const variant = useMemo(() => getPostVariant(post), [post]);
  const [formState, setFormState] = useState(() => buildInitialForm(post));
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setFormState(buildInitialForm(post));
    setFieldErrors({});
    setSubmitError('');
    setSubmitting(false);
  }, [post]);

  useEffect(() => {
    if (!open) return undefined;

    function handleEscape(event) {
      if (event.key !== 'Escape' || submitting) return;
      onClose?.();
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open, onClose, submitting]);

  if (!open || !post?.id) return null;

  function updateField(field, value) {
    setFormState((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setSubmitError('');
  }

  async function handleImageChange(event) {
    const [file] = Array.from(event.target.files || []);
    if (!file) return;

    try {
      const parsed = await readImageFile(file);
      setFormState((prev) => ({
        ...prev,
        imagePreview: parsed.dataUrl,
        imageFileName: parsed.fileName,
        imageFileType: parsed.fileType,
        imageFileSize: parsed.fileSize,
        imageEntityId: createEntityId('image-upload'),
        imageChanged: true,
      }));
      setSubmitError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load image.';
      setSubmitError(message);
      onFeedback?.({ type: 'error', message });
    } finally {
      event.target.value = '';
    }
  }

  function removeImage() {
    setFormState((prev) => ({
      ...prev,
      imagePreview: '',
      imageFileName: '',
      imageFileType: '',
      imageFileSize: 0,
      imageEntityId: createEntityId('image-upload'),
      imageChanged: true,
    }));
    setSubmitError('');
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const errors = {};
    let payload = null;

    if (variant === 'job') {
      const jobTitle = normalizeText(formState.jobTitle);
      const companyName = normalizeText(formState.companyName);
      const jobDescription = normalizeText(formState.jobDescription);
      const salaryRange = normalizeText(formState.salaryRange);
      const expiresAt = localDateTimeToIso(formState.expiresAt);

      if (!jobTitle) errors.jobTitle = 'Job title is required.';
      if (!companyName) errors.companyName = 'Company name is required.';
      if (!jobDescription) errors.jobDescription = 'Job description is required.';
      if (!salaryRange) errors.salaryRange = 'Salary range is required.';
      if (!formState.expiresAt) {
        errors.expiresAt = 'Application deadline is required.';
      } else if (!expiresAt) {
        errors.expiresAt = 'Application deadline is invalid.';
      } else if (new Date(expiresAt).getTime() <= Date.now()) {
        errors.expiresAt = 'Application deadline must be in the future.';
      }

      if (Object.keys(errors).length === 0) {
        const jobRef = getJobRef(post);
        const existingMetadata = jobRef?.metadata && typeof jobRef.metadata === 'object'
          ? jobRef.metadata
          : {};
        payload = {
          title: jobTitle,
          summary: jobDescription,
          expiresAt,
          ref: {
            service: 'job-details',
            entityId: jobRef?.entityId || createEntityId('job-details'),
            metadata: {
              ...existingMetadata,
              jobTitle,
              companyName,
              jobDescription,
              salaryRange,
            },
          },
        };
      }
    } else if (variant === 'event') {
      const title = normalizeText(formState.title);
      const summary = normalizeText(formState.summary);
      const startsAt = formState.startsAt ? localDateTimeToIso(formState.startsAt) : null;
      const endsAt = formState.endsAt ? localDateTimeToIso(formState.endsAt) : null;
      const location = normalizeText(formState.location);
      const rules = normalizeText(formState.rules);
      const contactInfo = normalizeText(formState.contactInfo);
      const rsvpUrl = normalizeText(formState.rsvpUrl);
      const organizerNotes = normalizeText(formState.organizerNotes);

      if (!title) errors.title = 'Title is required.';
      if (!summary) errors.summary = 'Summary is required.';
      if (formState.startsAt && !startsAt) errors.startsAt = 'Start date/time is invalid.';
      if (formState.endsAt && !endsAt) errors.endsAt = 'End date/time is invalid.';
      if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
        errors.endsAt = 'End date/time should be after the start date/time.';
      }
      if (rsvpUrl) {
        try {
          // eslint-disable-next-line no-new
          new URL(rsvpUrl);
        } catch {
          errors.rsvpUrl = 'RSVP link must be a valid URL.';
        }
      }

      if (Object.keys(errors).length === 0) {
        const eventRef = getEventRef(post);
        const existingMetadata = eventRef?.metadata && typeof eventRef.metadata === 'object'
          ? eventRef.metadata
          : {};
        payload = {
          title,
          summary,
          ref: {
            service: 'event-details',
            entityId: eventRef?.entityId || createEntityId('event-details'),
            metadata: {
              ...existingMetadata,
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
        };
      }
    } else {
      const title = normalizeText(formState.title);
      const summary = normalizeText(formState.summary);
      const tags = uniqueCommaSeparatedValues(formState.tags);
      const expiresAt = formState.expiresAt ? localDateTimeToIso(formState.expiresAt) : null;

      if (!summary) errors.summary = 'Summary is required.';
      if (formState.expiresAt && !expiresAt) {
        errors.expiresAt = 'Expiry date/time is invalid.';
      }

      if (Object.keys(errors).length === 0) {
        payload = {
          title: title || null,
          summary,
          tags,
          expiresAt,
        };

        if (formState.imageChanged) {
          payload.ref = formState.imagePreview
            ? {
              service: 'image-upload',
              entityId: formState.imageEntityId || createEntityId('image-upload'),
              metadata: {
                imageDataUrl: formState.imagePreview,
                fileName: formState.imageFileName || 'post-image',
                fileType: formState.imageFileType || 'image/png',
                fileSize: Number.isFinite(Number(formState.imageFileSize))
                  ? Number(formState.imageFileSize)
                  : 0,
              },
            }
            : null;
        }
      }
    }

    setFieldErrors(errors);
    if (!payload || Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError('');

    try {
      const updatedPost = await updatePostById(post.id, payload);
      await onSaved?.(updatedPost);
      onFeedback?.({ type: 'success', message: getSuccessMessage(variant) });
      onClose?.();
    } catch (error) {
      const message = error instanceof Error ? getFailureMessage(variant, error) : 'Could not update post.';
      setSubmitError(message);
      onFeedback?.({ type: 'error', message });
    } finally {
      setSubmitting(false);
    }
  }

  const typeLabel = String(post?.type || 'POST').trim().toUpperCase();

  return (
    <div
      className="profile-edit-backdrop post-edit-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${typeLabel} post`}
      onClick={() => {
        if (submitting) return;
        onClose?.();
      }}
    >
      <section
        className={`panel profile-edit-modal post-edit-modal${variant === 'job' ? ' job-create-modal' : ''}${variant === 'event' ? ' collab-create-modal' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">Edit</p>
            <h3>{variant === 'job' ? 'Update Job Post' : variant === 'event' ? 'Update Event Post' : 'Update Post'}</h3>
            <p className="post-edit-intro">
              Review the editable owner fields below. Post type, moderation controls, and internal identifiers stay unchanged.
            </p>
          </div>
          <button type="button" className="btn btn-soft" onClick={() => onClose?.()} disabled={submitting}>
            Close
          </button>
        </div>

        <div className="post-edit-chip-row">
          <span className="pill">{typeLabel}</span>
          {post?.status ? <span className="pill">{String(post.status).toUpperCase()}</span> : null}
        </div>

        <form className="stacked-form post-edit-form" onSubmit={handleSubmit}>
          {variant === 'job' ? (
            <>
              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Role Details</p>
                  <h4>Position Basics</h4>
                </div>

                <div className="field-row two-col">
                  <label>
                    <span>Job Title <strong className="required-marker">*</strong></span>
                    <input
                      type="text"
                      value={formState.jobTitle}
                      onChange={(event) => updateField('jobTitle', event.target.value)}
                      disabled={submitting}
                    />
                    {fieldErrors.jobTitle && <small className="field-error">{fieldErrors.jobTitle}</small>}
                  </label>

                  <label>
                    <span>Company Name <strong className="required-marker">*</strong></span>
                    <input
                      type="text"
                      value={formState.companyName}
                      onChange={(event) => updateField('companyName', event.target.value)}
                      disabled={submitting}
                    />
                    {fieldErrors.companyName && <small className="field-error">{fieldErrors.companyName}</small>}
                  </label>
                </div>

                <label>
                  <span>Salary Range <strong className="required-marker">*</strong></span>
                  <input
                    type="text"
                    value={formState.salaryRange}
                    onChange={(event) => updateField('salaryRange', event.target.value)}
                    disabled={submitting}
                  />
                  {fieldErrors.salaryRange && <small className="field-error">{fieldErrors.salaryRange}</small>}
                </label>

                <label>
                  <span>Application Deadline <strong className="required-marker">*</strong></span>
                  <input
                    type="datetime-local"
                    value={formState.expiresAt}
                    onChange={(event) => updateField('expiresAt', event.target.value)}
                    disabled={submitting}
                  />
                  {fieldErrors.expiresAt && <small className="field-error">{fieldErrors.expiresAt}</small>}
                </label>
              </div>

              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Description</p>
                  <h4>Role Expectations</h4>
                </div>

                <label>
                  <span>Job Description <strong className="required-marker">*</strong></span>
                  <textarea
                    rows={5}
                    value={formState.jobDescription}
                    onChange={(event) => updateField('jobDescription', event.target.value)}
                    disabled={submitting}
                  />
                  {fieldErrors.jobDescription && <small className="field-error">{fieldErrors.jobDescription}</small>}
                </label>
              </div>
            </>
          ) : variant === 'event' ? (
            <>
              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Core Information</p>
                  <h4>Post Basics</h4>
                </div>

                <div className="field-row two-col">
                  <label>
                    <span>Post Type</span>
                    <input type="text" value={typeLabel} readOnly disabled />
                  </label>

                  <label>
                    <span>Location</span>
                    <input
                      type="text"
                      value={formState.location}
                      onChange={(event) => updateField('location', event.target.value)}
                      disabled={submitting}
                    />
                  </label>
                </div>

                <label>
                  <span>Title <strong className="required-marker">*</strong></span>
                  <input
                    type="text"
                    value={formState.title}
                    onChange={(event) => updateField('title', event.target.value)}
                    disabled={submitting}
                  />
                  {fieldErrors.title && <small className="field-error">{fieldErrors.title}</small>}
                </label>

                <label>
                  <span>Summary <strong className="required-marker">*</strong></span>
                  <textarea
                    rows={4}
                    value={formState.summary}
                    onChange={(event) => updateField('summary', event.target.value)}
                    disabled={submitting}
                  />
                  {fieldErrors.summary && <small className="field-error">{fieldErrors.summary}</small>}
                </label>
              </div>

              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Schedule</p>
                  <h4>Date and Time</h4>
                </div>

                <div className="field-row two-col">
                  <label>
                    <span>Starts At</span>
                    <input
                      type="datetime-local"
                      value={formState.startsAt}
                      onChange={(event) => updateField('startsAt', event.target.value)}
                      disabled={submitting}
                    />
                    {fieldErrors.startsAt && <small className="field-error">{fieldErrors.startsAt}</small>}
                  </label>

                  <label>
                    <span>Ends At</span>
                    <input
                      type="datetime-local"
                      value={formState.endsAt}
                      onChange={(event) => updateField('endsAt', event.target.value)}
                      disabled={submitting}
                    />
                    {fieldErrors.endsAt && <small className="field-error">{fieldErrors.endsAt}</small>}
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
                    <input
                      type="text"
                      value={formState.contactInfo}
                      onChange={(event) => updateField('contactInfo', event.target.value)}
                      disabled={submitting}
                    />
                  </label>

                  <label>
                    <span>RSVP Link</span>
                    <input
                      type="url"
                      value={formState.rsvpUrl}
                      onChange={(event) => updateField('rsvpUrl', event.target.value)}
                      disabled={submitting}
                    />
                    {fieldErrors.rsvpUrl && <small className="field-error">{fieldErrors.rsvpUrl}</small>}
                  </label>
                </div>

                <label>
                  <span>Rules or Guidelines</span>
                  <textarea
                    rows={3}
                    value={formState.rules}
                    onChange={(event) => updateField('rules', event.target.value)}
                    disabled={submitting}
                  />
                </label>

                <label>
                  <span>Organizer Notes</span>
                  <textarea
                    rows={3}
                    value={formState.organizerNotes}
                    onChange={(event) => updateField('organizerNotes', event.target.value)}
                    disabled={submitting}
                  />
                </label>
              </div>
            </>
          ) : (
            <>
              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Core Information</p>
                  <h4>Post Content</h4>
                </div>

                <label>
                  <span>Title</span>
                  <input
                    type="text"
                    value={formState.title}
                    onChange={(event) => updateField('title', event.target.value)}
                    disabled={submitting}
                  />
                </label>

                <label>
                  <span>Summary <strong className="required-marker">*</strong></span>
                  <textarea
                    rows={5}
                    value={formState.summary}
                    onChange={(event) => updateField('summary', event.target.value)}
                    disabled={submitting}
                  />
                  {fieldErrors.summary && <small className="field-error">{fieldErrors.summary}</small>}
                </label>

                <div className="field-row two-col">
                  <label>
                    <span>Tags</span>
                    <input
                      type="text"
                      placeholder="Comma separated, e.g. alumni, notice, internship"
                      value={formState.tags}
                      onChange={(event) => updateField('tags', event.target.value)}
                      disabled={submitting}
                    />
                  </label>

                  <label>
                    <span>Expiry</span>
                    <input
                      type="datetime-local"
                      value={formState.expiresAt}
                      onChange={(event) => updateField('expiresAt', event.target.value)}
                      disabled={submitting}
                    />
                    {fieldErrors.expiresAt && <small className="field-error">{fieldErrors.expiresAt}</small>}
                  </label>
                </div>
              </div>

              <div className="job-form-block">
                <div className="job-form-block-head">
                  <p className="eyebrow">Media</p>
                  <h4>Post Image</h4>
                </div>

                {formState.imagePreview ? (
                  <div className="post-edit-image-preview">
                    <img src={formState.imagePreview} alt={formState.title || post?.title || 'Post'} />
                  </div>
                ) : (
                  <p className="post-edit-muted">No image attached to this post.</p>
                )}

                <div className="post-edit-image-actions">
                  <label className="btn btn-soft post-edit-upload-btn">
                    <input type="file" accept="image/*" onChange={handleImageChange} disabled={submitting} />
                    {formState.imagePreview ? 'Replace image' : 'Add image'}
                  </label>

                  {formState.imagePreview && (
                    <button type="button" className="btn btn-soft" onClick={removeImage} disabled={submitting}>
                      Remove image
                    </button>
                  )}
                </div>
                <small className="composer-tag-hint">Use an image under 900 KB to stay aligned with the existing post composer.</small>
              </div>
            </>
          )}

          {submitError && <div className="field-error post-edit-submit-error">{submitError}</div>}

          <div className="job-composer-footer">
            <button type="button" className="btn btn-soft" onClick={() => onClose?.()} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary-solid" disabled={submitting}>
              {submitting ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
