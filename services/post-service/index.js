const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { query: searchQuery, isDbConfigured: isSearchDbConfigured, closePool: closeSearchDbPool } = require('./db');
const { buildNewsletterEmailBodies } = require('./newsletterTemplates');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = Number(process.env.PORT) || 3002;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_MAX_QUERY_LENGTH = 80;
const COLLAB_DEFAULT_LIMIT = 20;
const COLLAB_MAX_LIMIT = 100;
const COLLAB_NOTIFICATION_DEFAULT_LIMIT = 30;
const COLLAB_NOTIFICATION_MAX_LIMIT = 100;
const EVENT_NOTIFICATION_DEFAULT_LIMIT = 30;
const EVENT_NOTIFICATION_MAX_LIMIT = 100;
const NEWSLETTER_NOTIFICATION_DEFAULT_LIMIT = 30;
const NEWSLETTER_NOTIFICATION_MAX_LIMIT = 100;
const COLLAB_MODES = new Set(['remote', 'onsite', 'hybrid']);
const COLLAB_STATUSES = new Set(['open', 'closed']);
const COLLAB_JOIN_REQUEST_STATUSES = new Set(['pending', 'accepted', 'rejected']);
const COLLAB_FALLBACK_CATEGORY = 'Other Academic Collaboration';
const COLLAB_FALLBACK_DURATION = 'Not specified';
const COLLAB_FALLBACK_SKILL = 'General collaboration';
const EVENT_TYPES = new Set(['EVENT', 'EVENT_RECAP']);
const EVENT_DEFAULT_TITLE = {
    EVENT: 'Event update',
    EVENT_RECAP: 'Event recap update',
};
const EVENT_DEFAULT_SUMMARY = {
    EVENT: 'Event details will be updated soon.',
    EVENT_RECAP: 'Event recap details will be updated soon.',
};
const NEWSLETTER_BLOCKED_EMAIL_DOMAINS = new Set([
    'example.com',
    'example.net',
    'example.org',
    'localhost',
    'mailinator.com',
    'tempmail.com',
    'test.com',
]);
const NEWSLETTER_BLOCKED_EMAIL_TLDS = new Set([
    'example',
    'invalid',
    'local',
    'localhost',
    'test',
]);

const CONFIG = {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    schema: process.env.POST_SERVICE_SCHEMA || 'public',
    tables: {
        posts: process.env.POSTS_TABLE || 'posts',
        users: process.env.USERS_TABLE || 'users',
        userProfiles: process.env.USER_PROFILES_TABLE || 'user_profiles',
        tags: process.env.TAGS_TABLE || 'tags',
        postTags: process.env.POST_TAGS_TABLE || 'post_tags',
        postRefs: process.env.POST_REFS_TABLE || 'post_refs',
        postVotes: process.env.POST_VOTES_TABLE || 'post_votes',
        postComments: process.env.POST_COMMENTS_TABLE || 'post_comments',
        eventVolunteerEnrollments: process.env.EVENT_VOLUNTEER_ENROLLMENTS_TABLE || 'event_volunteer_enrollments',
        collabPosts: process.env.COLLAB_POSTS_TABLE || 'collab_posts',
        collabSkills: process.env.COLLAB_SKILLS_TABLE || 'collab_skills',
        collabJoinRequests: process.env.COLLAB_JOIN_REQUESTS_TABLE || 'collab_join_requests',
        collabMemberships: process.env.COLLAB_MEMBERSHIPS_TABLE || 'collab_memberships',
        alumniVerificationApplications: process.env.ALUMNI_VERIFICATION_TABLE || 'alumni_verification_applications',
        newsletterIssues: process.env.NEWSLETTER_ISSUES_TABLE || 'newsletter_issues',
        newsletterSendRuns: process.env.NEWSLETTER_SEND_RUNS_TABLE || 'newsletter_send_runs',
        newsletterSettings: process.env.NEWSLETTER_SETTINGS_TABLE || 'newsletter_settings',
    },
    feedDefaultLimit: Number(process.env.POST_FEED_DEFAULT_LIMIT) || 20,
    feedMaxLimit: Number(process.env.POST_FEED_MAX_LIMIT) || 100,
    archiveIntervalMs: Number(process.env.POST_ARCHIVE_INTERVAL_MS) || 0,
    jwtSecret: process.env.JWT_SECRET || 'HelloWorldKey',
    newsletter: {
        scheduleEnabled: String(process.env.NEWSLETTER_SCHEDULE_ENABLED || 'true').toLowerCase() !== 'false',
        scheduleIntervalMs: Number(process.env.NEWSLETTER_SCHEDULE_INTERVAL_MS) || (60 * 60 * 1000),
        timeZone: process.env.NEWSLETTER_TIMEZONE || 'Asia/Dhaka',
        appBaseUrl: process.env.NEWSLETTER_APP_BASE_URL || 'http://localhost:5173',
        smtpHost: process.env.SMTP_HOST || '',
        smtpPort: Number(process.env.SMTP_PORT) || 587,
        smtpSecure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
        smtpUser: process.env.SMTP_USER || '',
        smtpPass: process.env.SMTP_PASS || '',
        smtpFromEmail: process.env.SMTP_FROM_EMAIL || '',
        smtpFromName: process.env.SMTP_FROM_NAME || 'ICentral Academic Digest',
    },
};

function quoteIdentifier(value, label) {
    const normalized = String(value || '').trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized)) {
        throw new Error(`Invalid SQL identifier for ${label}: "${value}"`);
    }
    return `"${normalized}"`;
}

const DB_TABLE_IDENTIFIERS = (() => {
    const schema = quoteIdentifier(CONFIG.schema, 'schema');
    return {
        posts: `${schema}.${quoteIdentifier(CONFIG.tables.posts, 'posts table')}`,
        tags: `${schema}.${quoteIdentifier(CONFIG.tables.tags, 'tags table')}`,
        postTags: `${schema}.${quoteIdentifier(CONFIG.tables.postTags, 'post_tags table')}`,
        newsletterIssues: `${schema}.${quoteIdentifier(CONFIG.tables.newsletterIssues, 'newsletter_issues table')}`,
        newsletterSendRuns: `${schema}.${quoteIdentifier(CONFIG.tables.newsletterSendRuns, 'newsletter_send_runs table')}`,
    };
})();

const supabase = (CONFIG.supabaseUrl && CONFIG.supabaseKey)
    ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
        auth: { persistSession: false },
        db: { schema: CONFIG.schema },
    })
    : null;
let newsletterTransporter = null;

function isSupabaseConfigured() {
    return Boolean(supabase);
}

function isMissingTableError(error) {
    return error?.code === '42P01';
}

function parseBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function parseIntInRange(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function slugify(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function sanitizeSearchTerm(term) {
    return String(term)
        .trim()
        .replace(/[(),]/g, ' ')
        .replace(/\s+/g, ' ');
}

function normalizeSearchQuery(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ');
}

function encodeSearchCursor({ rank, createdAt, id }) {
    const payload = {
        v: 1,
        rank: Number(rank),
        createdAt: createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString(),
        id: String(id),
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeSearchCursor(value) {
    if (!value) return { value: null };

    const raw = String(value).trim();
    if (!raw) return { value: null };

    let decodedText = '';
    try {
        decodedText = Buffer.from(raw, 'base64url').toString('utf8');
    } catch {
        try {
            decodedText = Buffer.from(raw, 'base64').toString('utf8');
        } catch {
            return { error: 'cursor is invalid' };
        }
    }

    try {
        const parsed = JSON.parse(decodedText);
        const rank = Number(parsed?.rank);
        const createdAt = new Date(parsed?.createdAt);
        const id = normalizeText(parsed?.id);

        if (!Number.isFinite(rank)) {
            return { error: 'cursor is invalid' };
        }

        if (Number.isNaN(createdAt.getTime())) {
            return { error: 'cursor is invalid' };
        }

        if (!id) {
            return { error: 'cursor is invalid' };
        }

        return {
            value: {
                rank,
                createdAt: createdAt.toISOString(),
                id,
            },
        };
    } catch {
        return { error: 'cursor is invalid' };
    }
}

function parseSearchRequest(query = {}) {
    const errors = [];
    const q = normalizeSearchQuery(query.q);
    const limit = parseIntInRange(query.limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
    const cursorResult = decodeSearchCursor(query.cursor);

    if (!q) {
        errors.push('q is required');
    } else if (q.length < SEARCH_MIN_QUERY_LENGTH) {
        errors.push(`q must be at least ${SEARCH_MIN_QUERY_LENGTH} characters`);
    } else if (q.length > SEARCH_MAX_QUERY_LENGTH) {
        errors.push(`q must be at most ${SEARCH_MAX_QUERY_LENGTH} characters`);
    }

    if (cursorResult.error) {
        errors.push(cursorResult.error);
    }

    return {
        q,
        limit,
        cursor: cursorResult.value || null,
        errors,
    };
}

function normalizeFeedSortOption(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'upvotes' ? 'upvotes' : 'new';
}

function encodeFeedCursor({ offset, authorId, sort }) {
    return Buffer.from(JSON.stringify({
        v: 1,
        offset: Number(offset) || 0,
        authorId: normalizeText(authorId),
        sort: normalizeFeedSortOption(sort),
    }), 'utf8').toString('base64url');
}

function decodeFeedCursor(value) {
    if (!value) return { value: null };

    let decodedText = '';
    try {
        decodedText = Buffer.from(String(value), 'base64url').toString('utf8');
    } catch {
        try {
            decodedText = Buffer.from(String(value), 'base64').toString('utf8');
        } catch {
            return { error: 'cursor is invalid' };
        }
    }

    try {
        const parsed = JSON.parse(decodedText);
        const offset = Number.parseInt(parsed?.offset, 10);
        if (!Number.isFinite(offset) || offset < 0) {
            return { error: 'cursor is invalid' };
        }
        return {
            value: {
                offset,
                authorId: normalizeText(parsed?.authorId),
                sort: normalizeFeedSortOption(parsed?.sort),
            },
        };
    } catch {
        return { error: 'cursor is invalid' };
    }
}

function sortFeedItems(items = [], sort = 'new') {
    const normalizedSort = normalizeFeedSortOption(sort);
    const cloned = items.slice();

    if (normalizedSort === 'upvotes') {
        cloned.sort((a, b) => {
            const upvotesA = Number.isFinite(Number(a?.upvoteCount)) ? Math.trunc(Number(a.upvoteCount)) : 0;
            const upvotesB = Number.isFinite(Number(b?.upvoteCount)) ? Math.trunc(Number(b.upvoteCount)) : 0;
            if (upvotesB !== upvotesA) return upvotesB - upvotesA;

            const createdAtA = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
            const createdAtB = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
            if (createdAtB !== createdAtA) return createdAtB - createdAtA;

            return String(b?.id || '').localeCompare(String(a?.id || ''));
        });
        return cloned;
    }

    cloned.sort((a, b) => {
        const createdAtA = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
        const createdAtB = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (createdAtB !== createdAtA) return createdAtB - createdAtA;
        return String(b?.id || '').localeCompare(String(a?.id || ''));
    });
    return cloned;
}

function pickDefined(fields) {
    return Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined)
    );
}

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => normalizeText(item)).filter(Boolean))];
}

function normalizeStringList(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeText(item)).filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(/\r?\n|;/)
            .map((item) => normalizeText(item.replace(/^[-*]\s*/, '')))
            .filter(Boolean);
    }

    return [];
}

function getDatePartsInTimeZone(date = new Date(), timeZone = CONFIG.newsletter.timeZone) {
    const targetDate = date instanceof Date ? date : new Date(date);
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = formatter.formatToParts(targetDate);
    const values = {};

    for (const part of parts) {
        if (part.type === 'literal') continue;
        values[part.type] = part.value;
    }

    const year = normalizeText(values.year);
    const month = normalizeText(values.month);
    const day = normalizeText(values.day);

    return {
        year,
        month,
        day,
        issueMonth: year && month ? `${year}-${month}` : '',
        issueDate: year && month && day ? `${year}-${month}-${day}` : '',
    };
}

function formatMonthYearLabelInTimeZone(value, timeZone = CONFIG.newsletter.timeZone) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'long',
        year: 'numeric',
    }).format(date);
}

function formatDateLabelInTimeZone(value, timeZone = CONFIG.newsletter.timeZone) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    }).format(date);
}

function formatDateTimeLabelInTimeZone(value, timeZone = CONFIG.newsletter.timeZone) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(date);
}

function formatIssueDateLabel(issueDate, timeZone = CONFIG.newsletter.timeZone) {
    const normalized = normalizeText(issueDate);
    if (!normalized) return '';
    const probe = new Date(`${normalized}T12:00:00Z`);
    if (Number.isNaN(probe.getTime())) return normalized;
    return formatDateLabelInTimeZone(probe, timeZone);
}

function getNewsletterIssueContext(now = new Date()) {
    const parts = getDatePartsInTimeZone(now, CONFIG.newsletter.timeZone);
    return {
        now: now instanceof Date ? now : new Date(now),
        nowIso: (now instanceof Date ? now : new Date(now)).toISOString(),
        issueMonth: parts.issueMonth,
        issueDate: parts.issueDate,
        issueMonthLabel: formatMonthYearLabelInTimeZone(now, CONFIG.newsletter.timeZone),
        issueDateLabel: formatDateLabelInTimeZone(now, CONFIG.newsletter.timeZone),
        day: Number.parseInt(parts.day || '0', 10) || 0,
    };
}

function truncateNewsletterText(value, maxLength = 220) {
    const normalized = normalizeText(value).replace(/\s+/g, ' ');
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function safeNewsletterCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.trunc(parsed));
}

function safeInteger(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.trunc(parsed);
}

function buildAppUrl(path = '') {
    const baseUrl = String(CONFIG.newsletter.appBaseUrl || '').trim().replace(/\/+$/, '');
    const normalizedPath = String(path || '').trim();
    if (!baseUrl) return normalizedPath || '';
    if (!normalizedPath) return baseUrl;
    return normalizedPath.startsWith('/')
        ? `${baseUrl}${normalizedPath}`
        : `${baseUrl}/${normalizedPath}`;
}

function findPostRefByService(post, serviceName) {
    if (!Array.isArray(post?.refs)) return null;
    const normalizedService = normalizeText(serviceName).toLowerCase();
    return post.refs.find((ref) => normalizeText(ref?.service).toLowerCase() === normalizedService) || null;
}

function getJobDetailsForNewsletter(post) {
    const ref = findPostRefByService(post, 'job-details');
    const metadata = ref?.metadata && typeof ref.metadata === 'object' ? ref.metadata : {};

    return {
        jobTitle: normalizeText(metadata.jobTitle) || normalizeText(post?.title) || 'Untitled position',
        companyName: normalizeText(metadata.companyName) || 'Company not specified',
        jobDescription: normalizeText(metadata.jobDescription) || normalizeText(post?.summary) || 'No description provided.',
        salaryRange: normalizeText(metadata.salaryRange) || 'Not specified',
    };
}

function getEventDetailsForNewsletter(post) {
    const ref = findPostRefByService(post, 'event-details');
    const metadata = ref?.metadata && typeof ref.metadata === 'object' ? ref.metadata : {};
    const startsAt = normalizeText(
        metadata.startsAt
        ?? metadata.startAt
        ?? metadata.start_date
        ?? metadata.date
    );
    const endsAt = normalizeText(
        metadata.endsAt
        ?? metadata.endAt
        ?? metadata.end_date
    );
    const location = normalizeText(
        metadata.location
        ?? metadata.venue
        ?? metadata.place
        ?? metadata.address
    );
    const contactInfo = normalizeText(
        metadata.contactInfo
        ?? metadata.contact
        ?? metadata.contactEmail
        ?? metadata.contact_email
    );
    const rsvpUrl = normalizeText(
        metadata.rsvpUrl
        ?? metadata.registrationUrl
        ?? metadata.rsvp
    );
    const organizerNotes = normalizeText(
        metadata.organizerNotes
        ?? metadata.notes
        ?? metadata.description
    );

    return {
        startsAt: startsAt || null,
        endsAt: endsAt || null,
        location: location || 'Location to be announced',
        contactInfo: contactInfo || null,
        rsvpUrl: rsvpUrl || null,
        organizerNotes: organizerNotes || null,
        rules: normalizeStringList(metadata.rules ?? metadata.guidelines ?? metadata.instructions),
    };
}

function summarizeNewsletterCounts(contentSummary = {}) {
    const sections = contentSummary?.sections || {};
    const achievementCount = Array.isArray(sections.achievement) ? sections.achievement.length : 0;
    const jobCount = Array.isArray(sections.jobs) ? sections.jobs.length : 0;
    const eventCount = Array.isArray(sections.events) ? sections.events.length : 0;
    const collabCount = Array.isArray(sections.collabs) ? sections.collabs.length : 0;

    return {
        achievement: achievementCount,
        jobs: jobCount,
        events: eventCount,
        collabs: collabCount,
        total: achievementCount + jobCount + eventCount + collabCount,
    };
}

function normalizeDate(value, fieldName) {
    if (value === undefined) return { value: undefined };
    if (value === null || value === '') return { value: null };

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return { error: `${fieldName} must be a valid date/time string` };
    }

    return { value: date.toISOString() };
}

function mapTag(row) {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: row.created_at,
    };
}

function mapPost(row) {
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        summary: row.summary,
        authorId: row.author_id,
        status: row.status,
        pinned: row.pinned,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function formatSupabaseError(error) {
    if (!error) return 'Unknown database error';
    return error.message || error.details || 'Unknown database error';
}

function parseVoteInput(value) {
    if (value === undefined || value === null || value === '') {
        return { error: 'vote is required' };
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'up', 'upvote', 'true'].includes(normalized)) return { value: 1 };
    if (['-1', 'down', 'downvote'].includes(normalized)) return { value: -1 };
    if (['0', 'none', 'clear', 'neutral', 'remove', 'false'].includes(normalized)) return { value: 0 };
    return { error: 'vote must be one of: up, down, none' };
}

function parseCommentInput(body = {}) {
    const content = normalizeText(body.content ?? body.comment ?? body.text);
    const errors = [];
    if (!content) {
        errors.push('content is required');
    } else if (content.length > 5000) {
        errors.push('content is too long');
    }

    return { content, errors };
}

function parseVolunteerEnrollmentInput(body = {}) {
    const fullName = normalizeText(body.fullName ?? body.full_name ?? body.name);
    const contactInfo = normalizeText(body.contactInfo ?? body.contact_info ?? body.contact);
    const reason = normalizeText(body.reason ?? body.motivation);
    const availability = normalizeText(body.availability ?? body.availableTimes ?? body.available_times) || null;
    const notes = normalizeText(body.notes ?? body.additionalNotes ?? body.additional_notes) || null;
    const errors = [];

    if (!fullName) {
        errors.push('fullName is required');
    } else if (fullName.length > 160) {
        errors.push('fullName is too long');
    }

    if (!contactInfo) {
        errors.push('contactInfo is required');
    } else if (contactInfo.length > 240) {
        errors.push('contactInfo is too long');
    }

    if (!reason) {
        errors.push('reason is required');
    } else if (reason.length > 2000) {
        errors.push('reason is too long');
    }

    if (availability && availability.length > 500) {
        errors.push('availability is too long');
    }

    if (notes && notes.length > 2000) {
        errors.push('notes is too long');
    }

    return {
        fullName,
        contactInfo,
        reason,
        availability,
        notes,
        errors,
    };
}

function mapComment(row, author = null) {
    return {
        id: row.id,
        postId: row.post_id,
        authorId: row.author_id,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        author,
    };
}

function mapEventVolunteerEnrollment(row, user = null) {
    return {
        id: row.id,
        postId: row.post_id,
        userId: row.user_id,
        fullName: row.full_name,
        contactInfo: row.contact_info,
        reason: row.reason,
        availability: row.availability || null,
        notes: row.notes || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        user,
    };
}

function dbUnavailable(res) {
    return res.status(503).json({
        error: 'Post service database is not configured',
        requiredEnv: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    });
}

function searchDbUnavailable(res) {
    return res.status(503).json({
        error: 'Post search database is not configured',
        requiredEnv: ['SUPABASE_DB_URL'],
    });
}

function socialSchemaError(res) {
    return res.status(500).json({
        error: `Missing social tables. Run services/post-service/schema.sql first.`,
    });
}

function collabSchemaError(res) {
    return res.status(500).json({
        error: `Missing collaboration tables. Run services/post-service/schema.sql first.`,
    });
}

function newsletterSchemaError(res) {
    return res.status(500).json({
        error: `Missing newsletter tables. Run services/post-service/schema.sql first.`,
    });
}

function newsletterEmailUnavailable(res) {
    return res.status(503).json({
        error: 'Newsletter email delivery is not configured',
        requiredEnv: ['SMTP_HOST', 'SMTP_FROM_EMAIL'],
    });
}

function ensureDb(req, res, next) {
    if (!isSupabaseConfigured()) {
        return dbUnavailable(res);
    }
    return next();
}

function ensureSearchDb(req, res, next) {
    if (!isSearchDbConfigured()) {
        return searchDbUnavailable(res);
    }
    return next();
}

function ensureAuthenticated(req, res, next) {
    const requestUser = getRequestUser(req);
    if (!requestUser?.id) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    req.requestUser = requestUser;
    return next();
}

function ensureModerator(req, res, next) {
    if (!isModeratorRole(req.requestUser?.role)) {
        return res.status(403).json({ error: 'Only faculty/admin can access this route.' });
    }
    return next();
}

function getRequestUser(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;

    const token = header.slice(7).trim();
    if (!token) return null;

    try {
        return jwt.verify(token, CONFIG.jwtSecret);
    } catch {
        return null;
    }
}

function isModeratorRole(role) {
    const normalized = String(role || '').toLowerCase();
    return normalized === 'admin' || normalized === 'faculty';
}

function isAlumniRole(role) {
    return String(role || '').toLowerCase() === 'alumni';
}

function canCreateAnnouncement(role) {
    return isModeratorRole(role);
}

function canCreateJobAsBypassRole(role) {
    return isModeratorRole(role);
}

function isNewsletterEmailConfigured() {
    return Boolean(
        normalizeText(CONFIG.newsletter.smtpHost)
        && normalizeText(CONFIG.newsletter.smtpFromEmail)
    );
}

function getNewsletterTransporter() {
    if (!isNewsletterEmailConfigured()) {
        const error = new Error('Newsletter email delivery is not configured.');
        error.status = 503;
        error.requiredEnv = ['SMTP_HOST', 'SMTP_FROM_EMAIL'];
        throw error;
    }

    if (!newsletterTransporter) {
        const auth = normalizeText(CONFIG.newsletter.smtpUser)
            ? {
                user: CONFIG.newsletter.smtpUser,
                pass: CONFIG.newsletter.smtpPass,
            }
            : undefined;

        newsletterTransporter = nodemailer.createTransport({
            host: CONFIG.newsletter.smtpHost,
            port: CONFIG.newsletter.smtpPort,
            secure: CONFIG.newsletter.smtpSecure,
            ...(auth ? { auth } : {}),
        });
    }

    return newsletterTransporter;
}

function isCollabType(value) {
    return String(value || '').trim().toUpperCase() === 'COLLAB';
}

function isEventType(value) {
    return EVENT_TYPES.has(String(value || '').trim().toUpperCase());
}

function getDefaultEventTitle(type) {
    const normalizedType = String(type || '').trim().toUpperCase();
    return EVENT_DEFAULT_TITLE[normalizedType] || EVENT_DEFAULT_TITLE.EVENT;
}

function getDefaultEventSummary(type) {
    const normalizedType = String(type || '').trim().toUpperCase();
    return EVENT_DEFAULT_SUMMARY[normalizedType] || EVENT_DEFAULT_SUMMARY.EVENT;
}

function resolveVerificationStatus(rows) {
    const applications = Array.isArray(rows) ? rows : [];
    if (applications.some((item) => item.status === 'approved')) return 'approved';
    if (applications.some((item) => item.status === 'pending')) return 'pending';
    if (applications.some((item) => item.status === 'rejected')) return 'rejected';
    return 'not_submitted';
}

async function getAlumniVerificationStatus(applicantId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.alumniVerificationApplications)
        .select('status, created_at')
        .eq('applicant_id', applicantId)
        .order('created_at', { ascending: false });

    if (error) {
        throw error;
    }

    return resolveVerificationStatus(data || []);
}

function buildPostPayload(body, { partial = false } = {}) {
    const errors = [];

    const expiresAtResult = normalizeDate(
        body.expiresAt !== undefined ? body.expiresAt : body.expires_at,
        'expiresAt'
    );

    if (expiresAtResult.error) {
        errors.push(expiresAtResult.error);
    }

    const statusInput = body.status;
    const archiveInput = body.archive;
    let status = statusInput;

    if (archiveInput === true || archiveInput === 'true' || archiveInput === 1 || archiveInput === '1') {
        status = 'archived';
    }

    const postFields = pickDefined({
        type: body.type,
        title: body.title,
        summary: body.summary,
        author_id: body.authorId ?? body.author_id,
        status: status,
        pinned: body.pinned !== undefined ? parseBool(body.pinned) : undefined,
        expires_at: expiresAtResult.value,
    });

    if (typeof postFields.type === 'string') {
        postFields.type = normalizeText(postFields.type)
            .replace(/[\s-]+/g, '_')
            .toUpperCase();
    }

    if (!partial) {
        if (!postFields.type) {
            postFields.type = 'GENERAL';
        }
        if (postFields.author_id !== undefined && String(postFields.author_id).trim() === '') {
            errors.push('authorId cannot be empty');
        }
        if (!postFields.status) {
            postFields.status = 'draft';
        }
        if (postFields.pinned === undefined) {
            postFields.pinned = false;
        }
    }

    if (postFields.type !== undefined && typeof postFields.type !== 'string') {
        errors.push('type must be a string');
    }
    if (postFields.title !== undefined && postFields.title !== null && typeof postFields.title !== 'string') {
        errors.push('title must be a string or null');
    }
    if (postFields.summary !== undefined && postFields.summary !== null && typeof postFields.summary !== 'string') {
        errors.push('summary must be a string or null');
    }
    if (postFields.status !== undefined && typeof postFields.status !== 'string') {
        errors.push('status must be a string');
    }

    let tagIds = [];
    let tagNames = [];
    let tagsProvided = false;

    if (Array.isArray(body.tagIds)) {
        tagsProvided = true;
        tagIds = body.tagIds.map((id) => String(id).trim()).filter(Boolean);
    }

    if (Array.isArray(body.tags)) {
        tagsProvided = true;
        if (body.tags.every((tag) => typeof tag === 'string')) {
            tagNames = body.tags.map((tag) => tag.trim()).filter(Boolean);
        } else if (body.tags.every((tag) => tag && typeof tag === 'object')) {
            tagIds = [
                ...tagIds,
                ...body.tags
                    .map((tag) => (tag.id !== undefined ? String(tag.id).trim() : ''))
                    .filter(Boolean),
            ];
            tagNames = [
                ...tagNames,
                ...body.tags
                    .map((tag) => (typeof tag.name === 'string' ? tag.name.trim() : ''))
                    .filter(Boolean),
            ];
        } else {
            errors.push('tags must be an array of strings or objects');
        }
    }

    const refInput = body.ref ?? body.postRef ?? body.post_ref;
    let ref;

    if (refInput !== undefined) {
        if (refInput === null) {
            ref = null;
        } else if (
            typeof refInput === 'object' &&
            typeof refInput.service === 'string' &&
            refInput.service.trim() &&
            refInput.entityId !== undefined
        ) {
            ref = {
                service: refInput.service.trim(),
                entity_id: String(refInput.entityId).trim(),
                metadata: (refInput.metadata && typeof refInput.metadata === 'object')
                    ? refInput.metadata
                    : {},
            };
        } else if (
            typeof refInput === 'object' &&
            typeof refInput.service === 'string' &&
            refInput.service.trim() &&
            refInput.entity_id !== undefined
        ) {
            ref = {
                service: refInput.service.trim(),
                entity_id: String(refInput.entity_id).trim(),
                metadata: (refInput.metadata && typeof refInput.metadata === 'object')
                    ? refInput.metadata
                    : {},
            };
        } else {
            errors.push('ref must include service and entityId');
        }
    }

    return {
        errors,
        postFields,
        tagsProvided,
        tagIds: [...new Set(tagIds)],
        tagNames: [...new Set(tagNames)],
        refProvided: refInput !== undefined,
        ref,
    };
}

async function archiveExpiredPosts() {
    if (!isSupabaseConfigured()) {
        return { archivedCount: 0, skipped: true };
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .update({ status: 'archived' })
        .lt('expires_at', nowIso)
        .neq('status', 'archived')
        .select('id');

    if (error) {
        throw error;
    }

    return { archivedCount: data?.length || 0 };
}

async function getPostRefs(postIds) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.postRefs)
        .select('post_id, service, entity_id, metadata, created_at')
        .in('post_id', postIds);

    if (error) {
        if (error.code === '42P01') return new Map();
        throw error;
    }

    const refsByPostId = new Map();
    for (const row of data || []) {
        const existing = refsByPostId.get(row.post_id) || [];
        existing.push({
            service: row.service,
            entityId: row.entity_id,
            metadata: row.metadata || {},
            createdAt: row.created_at,
        });
        refsByPostId.set(row.post_id, existing);
    }

    return refsByPostId;
}

async function attachTags(posts) {
    if (!posts.length) return posts;

    const postIds = posts.map((post) => post.id);
    const { data: postTagRows, error: postTagsError } = await supabase
        .from(CONFIG.tables.postTags)
        .select('post_id, tag_id')
        .in('post_id', postIds);

    if (postTagsError) {
        if (postTagsError.code === '42P01') {
            return posts.map((post) => ({ ...post, tags: [] }));
        }
        throw postTagsError;
    }

    const tagIds = [...new Set((postTagRows || []).map((row) => row.tag_id))];
    if (!tagIds.length) {
        return posts.map((post) => ({ ...post, tags: [] }));
    }

    const { data: tagRows, error: tagsError } = await supabase
        .from(CONFIG.tables.tags)
        .select('id, name, slug, created_at')
        .in('id', tagIds);

    if (tagsError) {
        if (tagsError.code === '42P01') {
            return posts.map((post) => ({ ...post, tags: [] }));
        }
        throw tagsError;
    }

    const tagMap = new Map((tagRows || []).map((tag) => [tag.id, mapTag(tag)]));
    const tagsByPostId = new Map();

    for (const row of postTagRows || []) {
        const tag = tagMap.get(row.tag_id);
        if (!tag) continue;
        const existing = tagsByPostId.get(row.post_id) || [];
        existing.push(tag);
        tagsByPostId.set(row.post_id, existing);
    }

    return posts.map((post) => ({
        ...post,
        tags: tagsByPostId.get(post.id) || [],
    }));
}

async function getUsersByIds(userIds = []) {
    if (!userIds.length) return new Map();

    const { data: userRows, error } = await supabase
        .from(CONFIG.tables.users)
        .select('id, full_name, email, role')
        .in('id', userIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const userProfileById = new Map();
    try {
        const { data: profileRows, error: profileError } = await supabase
            .from(CONFIG.tables.userProfiles)
            .select('user_id, full_name, avatar_url')
            .in('user_id', userIds);

        if (profileError) {
            if (!isMissingTableError(profileError)) {
                throw profileError;
            }
        } else {
            for (const row of profileRows || []) {
                userProfileById.set(row.user_id, row);
            }
        }
    } catch (profileFetchError) {
        if (!isMissingTableError(profileFetchError)) {
            throw profileFetchError;
        }
    }

    const userMap = new Map();
    for (const row of userRows || []) {
        const profile = userProfileById.get(row.id);
        const profileName = normalizeText(profile?.full_name);
        userMap.set(row.id, {
            id: row.id,
            fullName: profileName || row.full_name || null,
            email: row.email || null,
            role: row.role || null,
            avatarUrl: normalizeText(profile?.avatar_url) || null,
        });
    }
    return userMap;
}

async function getVoteSummaryByPostIds(postIds = [], requestUserId = null) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.postVotes)
        .select('post_id, user_id, vote')
        .in('post_id', postIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const summaryByPostId = new Map();
    for (const row of data || []) {
        const vote = Number(row.vote);
        const safeVote = vote === 1 ? 1 : vote === -1 ? -1 : 0;
        const existing = summaryByPostId.get(row.post_id) || {
            score: 0,
            voteScore: 0,
            upvoteCount: 0,
            downvoteCount: 0,
            userVote: null,
        };

        if (safeVote === 1) existing.upvoteCount += 1;
        if (safeVote === -1) existing.downvoteCount += 1;
        existing.score += safeVote;
        existing.voteScore += safeVote;

        if (requestUserId && String(row.user_id) === String(requestUserId)) {
            existing.userVote = safeVote === 1 ? 'up' : safeVote === -1 ? 'down' : null;
        }
        summaryByPostId.set(row.post_id, existing);
    }

    return summaryByPostId;
}

async function getCommentCountByPostIds(postIds = []) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.postComments)
        .select('post_id')
        .in('post_id', postIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const countByPostId = new Map();
    for (const row of data || []) {
        const current = countByPostId.get(row.post_id) || 0;
        countByPostId.set(row.post_id, current + 1);
    }
    return countByPostId;
}

async function getCommentsForPost(postId, { limit = 50, offset = 0 } = {}) {
    const { data, error, count } = await supabase
        .from(CONFIG.tables.postComments)
        .select('*', { count: 'exact' })
        .eq('post_id', postId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (error) {
        throw error;
    }

    const rows = data || [];
    const authorIds = [...new Set(rows.map((row) => row.author_id).filter(Boolean))];
    const userMap = await getUsersByIds(authorIds);

    return {
        data: rows.map((row) => mapComment(row, userMap.get(row.author_id) || null)),
        pagination: {
            limit,
            offset,
            total: count ?? rows.length,
        },
    };
}

async function getPostCommentById(postId, commentId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.postComments)
        .select('*')
        .eq('id', commentId)
        .eq('post_id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function getEventVolunteerSummaryByPostIds(postIds = [], requestUserId = null) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.eventVolunteerEnrollments)
        .select('post_id, user_id')
        .in('post_id', postIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const summaryByPostId = new Map();
    for (const row of data || []) {
        const existing = summaryByPostId.get(row.post_id) || {
            volunteerCount: 0,
            viewerHasVolunteerEnrollment: false,
        };

        existing.volunteerCount += 1;
        if (requestUserId && String(row.user_id) === String(requestUserId)) {
            existing.viewerHasVolunteerEnrollment = true;
        }

        summaryByPostId.set(row.post_id, existing);
    }

    return summaryByPostId;
}

async function getEventVolunteerEnrollmentByPostAndUser(postId, userId) {
    const normalizedPostId = normalizeText(postId);
    const normalizedUserId = normalizeText(userId);
    if (!normalizedPostId || !normalizedUserId) return null;

    const { data, error } = await supabase
        .from(CONFIG.tables.eventVolunteerEnrollments)
        .select('*')
        .eq('post_id', normalizedPostId)
        .eq('user_id', normalizedUserId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function getEventVolunteerEnrollments(postId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.eventVolunteerEnrollments)
        .select('*')
        .eq('post_id', postId)
        .order('created_at', { ascending: false });

    if (error) {
        throw error;
    }

    const rows = data || [];
    const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
    const userMap = await getUsersByIds(userIds);

    return rows.map((row) => mapEventVolunteerEnrollment(row, userMap.get(row.user_id) || null));
}

async function enrichPosts(postRows, { requestUserId = null } = {}) {
    const mapped = postRows.map(mapPost);
    if (!mapped.length) return [];

    const withTags = await attachTags(mapped);
    const postIds = withTags.map((post) => post.id);
    const authorIds = [...new Set(withTags.map((post) => post.authorId).filter(Boolean))];
    const refsByPostId = await getPostRefs(postIds);
    const authorMap = await getUsersByIds(authorIds);
    const voteSummaryByPostId = await getVoteSummaryByPostIds(postIds, requestUserId);
    const commentCountByPostId = await getCommentCountByPostIds(postIds);
    const volunteerSummaryByPostId = await getEventVolunteerSummaryByPostIds(postIds, requestUserId);

    return withTags.map((post) => {
        const voteSummary = voteSummaryByPostId.get(post.id) || {
            score: 0,
            voteScore: 0,
            upvoteCount: 0,
            downvoteCount: 0,
            userVote: null,
        };
        const commentCount = commentCountByPostId.get(post.id) || 0;
        const volunteerSummary = volunteerSummaryByPostId.get(post.id) || {
            volunteerCount: 0,
            viewerHasVolunteerEnrollment: false,
        };
        const author = post.authorId ? (authorMap.get(post.authorId) || null) : null;

        return {
            ...post,
            author,
            authorName: author?.fullName || author?.email || null,
            refs: refsByPostId.get(post.id) || [],
            score: voteSummary.score,
            voteScore: voteSummary.voteScore,
            upvoteCount: voteSummary.upvoteCount,
            downvoteCount: voteSummary.downvoteCount,
            userVote: voteSummary.userVote,
            commentCount,
            commentsCount: commentCount,
            volunteerCount: volunteerSummary.volunteerCount,
            viewerHasVolunteerEnrollment: Boolean(volunteerSummary.viewerHasVolunteerEnrollment),
        };
    });
}

async function ensureTagsExist(tagNames) {
    if (!tagNames.length) return [];

    const names = [...new Set(tagNames.map((tag) => tag.trim()).filter(Boolean))];
    if (!names.length) return [];

    const upsertPayload = names.map((name) => ({
        name,
        slug: slugify(name),
    }));

    const { data, error } = await supabase
        .from(CONFIG.tables.tags)
        .upsert(upsertPayload, { onConflict: 'slug' })
        .select('id, name, slug, created_at');

    if (error) {
        throw error;
    }

    return data || [];
}

async function replacePostTags(postId, tagIds = [], tagNames = []) {
    const ensuredTags = await ensureTagsExist(tagNames);
    const mergedTagIds = [
        ...new Set([
            ...tagIds.map((id) => String(id)),
            ...ensuredTags.map((tag) => String(tag.id)),
        ]),
    ];

    const { error: deleteError } = await supabase
        .from(CONFIG.tables.postTags)
        .delete()
        .eq('post_id', postId);

    if (deleteError && deleteError.code !== '42P01') {
        throw deleteError;
    }

    if (!mergedTagIds.length) {
        return;
    }

    const rows = mergedTagIds.map((tagId) => ({
        post_id: postId,
        tag_id: tagId,
    }));

    const { error: insertError } = await supabase
        .from(CONFIG.tables.postTags)
        .insert(rows);

    if (insertError) {
        throw insertError;
    }
}

async function replacePostRef(postId, ref) {
    const { error: deleteError } = await supabase
        .from(CONFIG.tables.postRefs)
        .delete()
        .eq('post_id', postId);

    if (deleteError && deleteError.code !== '42P01') {
        throw deleteError;
    }

    if (!ref) return;

    const { error: insertError } = await supabase
        .from(CONFIG.tables.postRefs)
        .insert({
            post_id: postId,
            service: ref.service,
            entity_id: ref.entity_id,
            metadata: ref.metadata || {},
        });

    if (insertError) {
        throw insertError;
    }
}

async function getPostById(postId, options = {}) {
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('*')
        .eq('id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data) return null;

    const [enriched] = await enrichPosts([data], options);
    return enriched || null;
}

async function getPostsByIdsOrdered(postIds = []) {
    if (!postIds.length) return [];

    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('*')
        .in('id', postIds);

    if (error) {
        throw error;
    }

    const rowMap = new Map((data || []).map((row) => [String(row.id), row]));
    return postIds
        .map((id) => rowMap.get(String(id)))
        .filter(Boolean);
}

function mapSearchResultItem(post = {}) {
    const score = Number.isFinite(Number(post.score)) ? Math.trunc(Number(post.score)) : 0;
    const voteScore = Number.isFinite(Number(post.voteScore)) ? Math.trunc(Number(post.voteScore)) : score;
    const upvoteCount = Number.isFinite(Number(post.upvoteCount)) ? Math.max(0, Math.trunc(Number(post.upvoteCount))) : 0;
    const downvoteCount = Number.isFinite(Number(post.downvoteCount)) ? Math.max(0, Math.trunc(Number(post.downvoteCount))) : 0;
    const commentCount = Number.isFinite(Number(post.commentCount)) ? Math.max(0, Math.trunc(Number(post.commentCount))) : 0;

    return {
        id: post.id,
        type: post.type || null,
        title: post.title || null,
        summary: post.summary || null,
        authorId: post.authorId || null,
        authorName: post.authorName || null,
        author: post.author
            ? {
                id: post.author.id || null,
                fullName: post.author.fullName || null,
                avatarUrl: post.author.avatarUrl || null,
            }
            : null,
        status: post.status || null,
        pinned: Boolean(post.pinned),
        expiresAt: post.expiresAt || null,
        createdAt: post.createdAt || null,
        updatedAt: post.updatedAt || null,
        tags: Array.isArray(post.tags)
            ? post.tags.map((tag) => ({
                id: tag.id,
                name: tag.name,
                slug: tag.slug,
            }))
            : [],
        refs: Array.isArray(post.refs)
            ? post.refs.map((ref) => ({
                service: ref.service,
                entityId: ref.entityId,
                metadata: ref.metadata || {},
                createdAt: ref.createdAt || null,
            }))
            : [],
        score,
        voteScore,
        upvoteCount,
        downvoteCount,
        commentCount,
        commentsCount: commentCount,
        userVote: post.userVote === 'up' || post.userVote === 'down' ? post.userVote : null,
    };
}

function buildSearchPostsSql({ hasCursor }) {
    const cursorFilter = hasCursor
        ? `
    AND (
        rank < $2
        OR (rank = $2 AND created_at < $3::timestamptz)
        OR (rank = $2 AND created_at = $3::timestamptz AND id < $4::uuid)
    )`
        : '';

    const limitPlaceholder = hasCursor ? '$5' : '$2';
    const postsTable = DB_TABLE_IDENTIFIERS.posts;
    const postTagsTable = DB_TABLE_IDENTIFIERS.postTags;
    const tagsTable = DB_TABLE_IDENTIFIERS.tags;

    return `
WITH search_input AS (
    SELECT websearch_to_tsquery('english', $1) AS query
),
ranked_posts AS (
    SELECT
        p.id,
        p.created_at,
        (
            ts_rank_cd(
                to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.summary, '')),
                si.query
            )
            + CASE WHEN COALESCE(tag_match.is_match, false) THEN 0.075 ELSE 0 END
        ) AS rank
    FROM ${postsTable} p
    CROSS JOIN search_input si
    LEFT JOIN LATERAL (
        SELECT true AS is_match
        FROM ${postTagsTable} pt
        INNER JOIN ${tagsTable} t ON t.id = pt.tag_id
        WHERE pt.post_id = p.id
            AND (
                t.name ILIKE '%' || $1 || '%'
                OR t.slug ILIKE '%' || $1 || '%'
                OR to_tsvector('english', coalesce(t.name, '') || ' ' || coalesce(t.slug, '')) @@ si.query
            )
        LIMIT 1
    ) AS tag_match ON true
    WHERE p.status = 'published'
        AND (
            to_tsvector('english', coalesce(p.title, '') || ' ' || coalesce(p.summary, '')) @@ si.query
            OR COALESCE(tag_match.is_match, false)
        )
)
SELECT id, created_at, rank
FROM ranked_posts
WHERE rank > 0${cursorFilter}
ORDER BY rank DESC, created_at DESC, id DESC
LIMIT ${limitPlaceholder};
`;
}

async function searchPosts({ q, limit, cursor = null, requestUserId = null }) {
    const hasCursor = Boolean(cursor);
    const sql = buildSearchPostsSql({ hasCursor });
    const queryParams = [q];

    if (hasCursor) {
        queryParams.push(cursor.rank);
        queryParams.push(cursor.createdAt);
        queryParams.push(cursor.id);
    }

    queryParams.push(limit + 1);

    const result = await searchQuery(sql, queryParams);
    const rankedRows = Array.isArray(result?.rows) ? result.rows : [];
    const pageRows = rankedRows.slice(0, limit);
    const postIds = pageRows.map((row) => String(row.id)).filter(Boolean);

    if (!postIds.length) {
        return {
            items: [],
            nextCursor: null,
        };
    }

    const postRows = await getPostsByIdsOrdered(postIds);
    const enrichedPosts = await enrichPosts(postRows, { requestUserId });
    const byId = new Map(enrichedPosts.map((post) => [String(post.id), post]));
    const items = postIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map(mapSearchResultItem);

    let nextCursor = null;
    if (rankedRows.length > limit && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        const rank = Number(last.rank);
        if (Number.isFinite(rank) && last.created_at && last.id) {
            nextCursor = encodeSearchCursor({
                rank,
                createdAt: last.created_at,
                id: last.id,
            });
        }
    }

    return {
        items,
        nextCursor,
    };
}

async function getPostMetaById(postId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('id, type, title, status, author_id')
        .eq('id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function getPostAuthorId(postId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('author_id')
        .eq('id', postId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data) return null;
    return data.author_id || null;
}

async function resolveTagFilterPostIds(tagFilter) {
    if (!tagFilter) return null;

    const isUuidLike = /^[0-9a-fA-F-]{32,36}$/.test(String(tagFilter));
    let tagRowsQuery = supabase
        .from(CONFIG.tables.tags)
        .select('id, slug');

    if (isUuidLike) {
        tagRowsQuery = tagRowsQuery.eq('id', tagFilter);
    } else {
        tagRowsQuery = tagRowsQuery.or(`slug.eq.${slugify(tagFilter)},name.ilike.%${sanitizeSearchTerm(tagFilter)}%`);
    }

    const { data: tags, error: tagsError } = await tagRowsQuery;
    if (tagsError) {
        throw tagsError;
    }

    const tagIds = (tags || []).map((tag) => tag.id);
    if (!tagIds.length) return [];

    const { data: links, error: linksError } = await supabase
        .from(CONFIG.tables.postTags)
        .select('post_id, tag_id')
        .in('tag_id', tagIds);

    if (linksError) {
        throw linksError;
    }

    return [...new Set((links || []).map((link) => link.post_id))];
}

function toTitleCase(value) {
    const normalized = normalizeText(value);
    if (!normalized) return '';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function formatUserRole(role) {
    const normalized = normalizeText(role).toLowerCase();
    if (normalized === 'admin') return 'Admin';
    if (normalized === 'faculty') return 'Faculty';
    if (normalized === 'alumni') return 'Alumni';
    if (normalized === 'student') return 'Student';
    if (!normalized) return 'Member';
    return toTitleCase(normalized);
}

function uniqueTrimmedValues(values = []) {
    const seen = new Set();
    const normalizedValues = [];

    for (const value of values) {
        const normalized = normalizeText(value);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalizedValues.push(normalized);
    }

    return normalizedValues;
}

function parseStringListInput(value) {
    if (Array.isArray(value)) {
        return uniqueTrimmedValues(value);
    }

    if (typeof value === 'string') {
        return uniqueTrimmedValues(value.split(','));
    }

    return [];
}

function normalizeCollabMode(value, { allowEmpty = false, fieldName = 'mode' } = {}) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized && allowEmpty) return { value: null };
    if (!normalized) return { error: `${fieldName} is required` };
    if (!COLLAB_MODES.has(normalized)) {
        return { error: `${fieldName} must be one of: remote, onsite, hybrid` };
    }
    return { value: normalized };
}

function normalizeCollabStatus(value, { allowEmpty = false, fieldName = 'status' } = {}) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized && allowEmpty) return { value: null };
    if (!normalized) return { error: `${fieldName} is required` };
    if (!COLLAB_STATUSES.has(normalized)) {
        return { error: `${fieldName} must be one of: open, closed` };
    }
    return { value: normalized };
}

function normalizeJoinRequestStatus(value, { allowEmpty = false, fieldName = 'status' } = {}) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized && allowEmpty) return { value: null };
    if (!normalized) return { error: `${fieldName} is required` };
    if (!COLLAB_JOIN_REQUEST_STATUSES.has(normalized)) {
        return { error: `${fieldName} must be one of: pending, accepted, rejected` };
    }
    return { value: normalized };
}

function normalizeCollabSort(value) {
    const normalized = normalizeText(value).toLowerCase();
    return normalized === 'deadline' ? 'deadline' : 'newest';
}

function formatCollabMode(mode) {
    const normalized = normalizeText(mode).toLowerCase();
    if (normalized === 'remote') return 'REMOTE';
    if (normalized === 'onsite') return 'ONSITE';
    return 'HYBRID';
}

function formatCollabStatus(status) {
    const normalized = normalizeText(status).toLowerCase();
    return normalized === 'closed' ? 'CLOSED' : 'OPEN';
}

function formatJoinRequestStatus(status) {
    const normalized = normalizeText(status).toLowerCase();
    if (normalized === 'accepted') return 'ACCEPTED';
    if (normalized === 'rejected') return 'REJECTED';
    return 'PENDING';
}

function parseCollabTagInputs(body = {}) {
    const errors = [];
    let tagIds = [];
    let tagNames = [];
    let tagsProvided = false;

    if (Array.isArray(body.tagIds)) {
        tagsProvided = true;
        tagIds = body.tagIds
            .map((id) => String(id || '').trim())
            .filter(Boolean);
    }

    if (body.tags !== undefined) {
        tagsProvided = true;
        if (Array.isArray(body.tags)) {
            if (body.tags.every((tag) => typeof tag === 'string')) {
                tagNames = body.tags.map((tag) => String(tag).trim()).filter(Boolean);
            } else if (body.tags.every((tag) => tag && typeof tag === 'object')) {
                tagIds = [
                    ...tagIds,
                    ...body.tags
                        .map((tag) => (tag.id !== undefined ? String(tag.id).trim() : ''))
                        .filter(Boolean),
                ];
                tagNames = [
                    ...tagNames,
                    ...body.tags
                        .map((tag) => (typeof tag.name === 'string' ? tag.name.trim() : ''))
                        .filter(Boolean),
                ];
            } else {
                errors.push('tags must be an array of strings or objects');
            }
        } else if (typeof body.tags === 'string') {
            tagNames = parseStringListInput(body.tags);
        } else {
            errors.push('tags must be an array or comma-separated string');
        }
    }

    return {
        errors,
        tagsProvided,
        tagIds: [...new Set(tagIds)],
        tagNames: uniqueTrimmedValues(tagNames),
    };
}

function parseCollabPostPayload(body = {}, { partial = false } = {}) {
    const errors = [];
    const postFields = {};
    const collabFields = {};

    const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
    const hasSummary = Object.prototype.hasOwnProperty.call(body, 'summary');
    const hasCategory = Object.prototype.hasOwnProperty.call(body, 'category');
    const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description');
    const hasMode = Object.prototype.hasOwnProperty.call(body, 'mode');
    const hasTimeCommitment = Object.prototype.hasOwnProperty.call(body, 'timeCommitmentHoursPerWeek')
        || Object.prototype.hasOwnProperty.call(body, 'time_commitment_hours_per_week');
    const hasDuration = Object.prototype.hasOwnProperty.call(body, 'duration');
    const hasOpenings = Object.prototype.hasOwnProperty.call(body, 'openings');
    const hasPreferredBackground = Object.prototype.hasOwnProperty.call(body, 'preferredBackground')
        || Object.prototype.hasOwnProperty.call(body, 'preferred_background');
    const hasJoinUntil = Object.prototype.hasOwnProperty.call(body, 'joinUntil')
        || Object.prototype.hasOwnProperty.call(body, 'deadline');
    const hasContactMethod = Object.prototype.hasOwnProperty.call(body, 'contactMethod')
        || Object.prototype.hasOwnProperty.call(body, 'contact_method');
    const hasRequiredSkills = Object.prototype.hasOwnProperty.call(body, 'requiredSkills')
        || Object.prototype.hasOwnProperty.call(body, 'required_skills');

    if (!partial || hasTitle) {
        const title = normalizeText(body.title);
        if (!title) {
            errors.push('title is required');
        } else {
            postFields.title = title;
        }
    }

    if (!partial || hasSummary) {
        const summary = normalizeText(body.summary);
        if (!summary) {
            errors.push('summary is required');
        } else {
            postFields.summary = summary;
        }
    }

    if (!partial || hasCategory) {
        const category = normalizeText(body.category);
        if (!category) {
            errors.push('category is required');
        } else {
            collabFields.category = category;
        }
    }

    if (!partial || hasDescription) {
        const description = normalizeText(body.description);
        if (!description) {
            errors.push('description is required');
        } else {
            collabFields.description = description;
        }
    }

    if (!partial || hasMode) {
        const modeResult = normalizeCollabMode(body.mode, { fieldName: 'mode' });
        if (modeResult.error) {
            errors.push(modeResult.error);
        } else {
            collabFields.mode = modeResult.value;
        }
    }

    if (!partial || hasTimeCommitment) {
        const rawTimeCommitment = body.timeCommitmentHoursPerWeek !== undefined
            ? body.timeCommitmentHoursPerWeek
            : body.time_commitment_hours_per_week;
        const timeCommitment = Number.parseInt(rawTimeCommitment, 10);
        if (!Number.isFinite(timeCommitment) || timeCommitment <= 0) {
            errors.push('timeCommitmentHoursPerWeek must be a positive integer');
        } else {
            collabFields.time_commitment_hours_per_week = timeCommitment;
        }
    }

    if (!partial || hasDuration) {
        const duration = normalizeText(body.duration);
        if (!duration) {
            errors.push('duration is required');
        } else {
            collabFields.duration = duration;
        }
    }

    if (!partial || hasOpenings) {
        const openings = Number.parseInt(body.openings, 10);
        if (!Number.isFinite(openings) || openings <= 0) {
            errors.push('openings must be a positive integer');
        } else {
            collabFields.openings = openings;
        }
    }

    if (!partial || hasPreferredBackground) {
        const preferredBackground = body.preferredBackground !== undefined
            ? body.preferredBackground
            : body.preferred_background;
        collabFields.preferred_background = normalizeText(preferredBackground) || null;
    }

    if (!partial || hasContactMethod) {
        const contactMethod = body.contactMethod !== undefined
            ? body.contactMethod
            : body.contact_method;
        collabFields.contact_method = normalizeText(contactMethod) || null;
    }

    if (!partial || hasJoinUntil) {
        const deadlineInput = body.joinUntil !== undefined ? body.joinUntil : body.deadline;
        const deadlineResult = normalizeDate(deadlineInput, 'joinUntil');
        if (deadlineResult.error) {
            errors.push(deadlineResult.error);
        } else {
            collabFields.deadline = deadlineResult.value;
        }
    }

    let requiredSkills = [];
    let skillsProvided = false;
    if (hasRequiredSkills) {
        skillsProvided = true;
        const rawSkills = body.requiredSkills !== undefined ? body.requiredSkills : body.required_skills;
        requiredSkills = parseStringListInput(rawSkills);
    }

    if (!partial || hasRequiredSkills) {
        if (!requiredSkills.length) {
            errors.push('requiredSkills must include at least one skill');
        }
    }

    const tagPayload = parseCollabTagInputs(body);
    errors.push(...tagPayload.errors);

    return {
        errors,
        postFields,
        collabFields,
        skillsProvided: skillsProvided || !partial,
        requiredSkills,
        tagsProvided: tagPayload.tagsProvided,
        tagIds: tagPayload.tagIds,
        tagNames: tagPayload.tagNames,
    };
}

async function replaceCollabSkills(postId, requiredSkills = []) {
    const { error: deleteError } = await supabase
        .from(CONFIG.tables.collabSkills)
        .delete()
        .eq('post_id', postId);

    if (deleteError && !isMissingTableError(deleteError)) {
        throw deleteError;
    }

    if (!Array.isArray(requiredSkills) || requiredSkills.length === 0) {
        return;
    }

    const rows = uniqueTrimmedValues(requiredSkills).map((skill) => ({
        post_id: postId,
        skill,
    }));

    if (!rows.length) return;

    const { error: insertError } = await supabase
        .from(CONFIG.tables.collabSkills)
        .insert(rows);

    if (insertError) {
        throw insertError;
    }
}

function buildFallbackCollabDescription(postRow = {}) {
    const summary = normalizeText(postRow.summary);
    if (summary) return summary;

    const title = normalizeText(postRow.title);
    if (title) return `Collaboration opportunity: ${title}`;

    return 'Collaboration opportunity posted from the home feed.';
}

function buildFallbackEventMetadata(postRow = {}, postType = 'EVENT') {
    const normalizedType = String(postType || '').trim().toUpperCase();
    const createdAtInput = postRow?.created_at || postRow?.createdAt || null;
    const createdAtDate = createdAtInput ? new Date(createdAtInput) : null;
    const fallbackTimestamp = createdAtDate && !Number.isNaN(createdAtDate.getTime())
        ? createdAtDate.toISOString()
        : new Date().toISOString();
    const isRecap = normalizedType === 'EVENT_RECAP';

    return {
        startsAt: isRecap ? null : fallbackTimestamp,
        endsAt: isRecap ? fallbackTimestamp : null,
        venue: 'TBA',
        rsvpUrl: null,
    };
}

async function ensureDefaultEventRefForPost(postRow, refInput = null) {
    const postId = normalizeText(postRow?.id);
    if (!postId) {
        throw new Error('post id is required to create fallback event details');
    }

    const normalizedType = String(postRow?.type || '').trim().toUpperCase();
    if (!isEventType(normalizedType)) return;

    const requestedRefService = normalizeText(refInput?.service).toLowerCase();
    if (requestedRefService === 'event-details') {
        return;
    }

    const { data: existingRows, error: existingError } = await supabase
        .from(CONFIG.tables.postRefs)
        .select('id')
        .eq('post_id', postId)
        .eq('service', 'event-details')
        .limit(1);

    if (existingError) {
        throw existingError;
    }

    if (Array.isArray(existingRows) && existingRows.length > 0) {
        return;
    }

    const { error: insertError } = await supabase
        .from(CONFIG.tables.postRefs)
        .insert({
            post_id: postId,
            service: 'event-details',
            entity_id: `event-details-${postId}`,
            metadata: buildFallbackEventMetadata(postRow, normalizedType),
        });

    if (insertError) {
        throw insertError;
    }
}

async function ensureDefaultCollabDataForPost(postRow) {
    const postId = normalizeText(postRow?.id);
    if (!postId) {
        throw new Error('post id is required to create fallback collaboration data');
    }

    const nowIso = new Date().toISOString();
    const collabStatus = normalizeText(postRow?.status).toLowerCase() === 'archived'
        ? 'closed'
        : 'open';

    const { error: upsertError } = await supabase
        .from(CONFIG.tables.collabPosts)
        .upsert({
            post_id: postId,
            category: COLLAB_FALLBACK_CATEGORY,
            description: buildFallbackCollabDescription(postRow),
            mode: 'hybrid',
            time_commitment_hours_per_week: 1,
            duration: COLLAB_FALLBACK_DURATION,
            openings: 1,
            preferred_background: null,
            deadline: postRow?.expires_at || null,
            status: collabStatus,
            contact_method: null,
            updated_at: nowIso,
        }, {
            onConflict: 'post_id',
        });

    if (upsertError) {
        throw upsertError;
    }

    await replaceCollabSkills(postId, [COLLAB_FALLBACK_SKILL]);
}

async function getCollabPostMetaById(postId) {
    const normalizedId = normalizeText(postId);
    if (!normalizedId) return null;

    const { data: postRow, error: postError } = await supabase
        .from(CONFIG.tables.posts)
        .select('*')
        .eq('id', normalizedId)
        .eq('type', 'collab')
        .maybeSingle();

    if (postError) {
        throw postError;
    }

    if (!postRow) return null;

    const { data: collabRow, error: collabError } = await supabase
        .from(CONFIG.tables.collabPosts)
        .select('*')
        .eq('post_id', normalizedId)
        .maybeSingle();

    if (collabError) {
        throw collabError;
    }

    if (!collabRow) return null;

    return { postRow, collabRow };
}

async function getCollabSkillsByPostIds(postIds = []) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.collabSkills)
        .select('post_id, skill')
        .in('post_id', postIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const skillsByPostId = new Map();
    for (const row of data || []) {
        const existing = skillsByPostId.get(row.post_id) || [];
        existing.push(row.skill);
        skillsByPostId.set(row.post_id, existing);
    }

    for (const [postId, skills] of skillsByPostId.entries()) {
        skillsByPostId.set(postId, uniqueTrimmedValues(skills));
    }

    return skillsByPostId;
}

async function getCollabMemberCountByPostIds(postIds = []) {
    if (!postIds.length) return new Map();

    const { data, error } = await supabase
        .from(CONFIG.tables.collabMemberships)
        .select('post_id')
        .in('post_id', postIds);

    if (error) {
        if (isMissingTableError(error)) return new Map();
        throw error;
    }

    const countByPostId = new Map();
    for (const row of data || []) {
        const count = countByPostId.get(row.post_id) || 0;
        countByPostId.set(row.post_id, count + 1);
    }

    return countByPostId;
}

async function getCollabRequestSummaryByPostIds(postIds = [], requestUserId = null) {
    const totalCountByPostId = new Map();
    const pendingCountByPostId = new Map();
    const currentUserRequestByPostId = new Map();

    if (!postIds.length) {
        return {
            totalCountByPostId,
            pendingCountByPostId,
            currentUserRequestByPostId,
        };
    }

    const { data, error } = await supabase
        .from(CONFIG.tables.collabJoinRequests)
        .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
        .in('post_id', postIds);

    if (error) {
        if (isMissingTableError(error)) {
            return {
                totalCountByPostId,
                pendingCountByPostId,
                currentUserRequestByPostId,
            };
        }
        throw error;
    }

    for (const row of data || []) {
        const currentTotal = totalCountByPostId.get(row.post_id) || 0;
        totalCountByPostId.set(row.post_id, currentTotal + 1);

        const normalizedStatus = normalizeText(row.status).toLowerCase();
        if (normalizedStatus === 'pending') {
            const currentPending = pendingCountByPostId.get(row.post_id) || 0;
            pendingCountByPostId.set(row.post_id, currentPending + 1);
        }

        if (requestUserId && String(row.user_id) === String(requestUserId)) {
            currentUserRequestByPostId.set(row.post_id, row);
        }
    }

    return {
        totalCountByPostId,
        pendingCountByPostId,
        currentUserRequestByPostId,
    };
}

function mapCollabJoinRequest(row, userMap = new Map()) {
    const applicant = userMap.get(row.user_id);
    const applicantName = normalizeText(applicant?.fullName) || normalizeText(applicant?.email) || 'Community member';

    return {
        id: row.id,
        postId: row.post_id,
        userId: row.user_id,
        message: normalizeText(row.message),
        status: formatJoinRequestStatus(row.status),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        reviewedAt: row.reviewed_at,
        applicantName,
        applicantRole: formatUserRole(applicant?.role),
        applicant: applicant
            ? {
                id: applicant.id,
                fullName: applicant.fullName,
                email: applicant.email,
                role: applicant.role,
                avatarUrl: applicant.avatarUrl,
            }
            : null,
    };
}

function mapCollabMembership(row, userMap = new Map()) {
    const user = userMap.get(row.user_id);
    const name = normalizeText(user?.fullName) || normalizeText(user?.email) || 'Collaborator';

    return {
        id: row.id,
        postId: row.post_id,
        userId: row.user_id,
        teamRole: normalizeText(row.team_role) || null,
        name,
        role: formatUserRole(user?.role),
        acceptedAt: row.created_at,
        user: user
            ? {
                id: user.id,
                fullName: user.fullName,
                email: user.email,
                role: user.role,
                avatarUrl: user.avatarUrl,
            }
            : null,
    };
}

function mapCollabPostRecord({
    post,
    collab,
    tags = [],
    skills = [],
    author = null,
    requestCount = 0,
    pendingRequestCount = 0,
    memberCount = 0,
    currentUserRequest = null,
    score = 0,
    voteScore = 0,
    upvoteCount = 0,
    downvoteCount = 0,
    commentCount = 0,
    userVote = null,
}) {
    const safeOpenings = Number.isFinite(Number(collab?.openings))
        ? Math.max(1, Math.trunc(Number(collab.openings)))
        : 1;
    const safeMemberCount = Number.isFinite(Number(memberCount))
        ? Math.max(0, Math.trunc(Number(memberCount)))
        : 0;
    const safeRequestCount = Number.isFinite(Number(requestCount))
        ? Math.max(0, Math.trunc(Number(requestCount)))
        : 0;
    const safePendingRequestCount = Number.isFinite(Number(pendingRequestCount))
        ? Math.max(0, Math.trunc(Number(pendingRequestCount)))
        : 0;
    const openingsLeft = Math.max(0, safeOpenings - safeMemberCount);
    const creatorName = normalizeText(author?.fullName) || normalizeText(author?.email) || 'Community member';
    const roleLabel = formatUserRole(author?.role);

    return {
        id: post.id,
        type: post.type,
        title: post.title,
        summary: post.summary,
        description: collab.description,
        category: collab.category,
        authorId: post.authorId,
        creator: {
            id: author?.id || post.authorId || '',
            name: creatorName,
            role: roleLabel,
        },
        author: author
            ? {
                id: author.id,
                fullName: author.fullName,
                email: author.email,
                role: author.role,
                avatarUrl: author.avatarUrl,
            }
            : null,
        requiredSkills: uniqueTrimmedValues(skills),
        preferredBackground: collab.preferred_background || '',
        timeCommitmentHoursPerWeek: Number.isFinite(Number(collab.time_commitment_hours_per_week))
            ? Math.max(1, Math.trunc(Number(collab.time_commitment_hours_per_week)))
            : 1,
        duration: collab.duration,
        mode: formatCollabMode(collab.mode),
        openings: safeOpenings,
        status: formatCollabStatus(collab.status),
        joinUntil: collab.deadline || null,
        deadline: collab.deadline || null,
        contactMethod: collab.contact_method || null,
        createdAt: post.createdAt,
        updatedAt: collab.updated_at || post.updatedAt,
        postStatus: post.status,
        tags: (tags || []).map((tag) => tag.name),
        tagObjects: tags || [],
        joinRequestCount: safeRequestCount,
        pendingRequestCount: safePendingRequestCount,
        memberCount: safeMemberCount,
        openingsLeft,
        currentUserRequest: currentUserRequest
            ? {
                id: currentUserRequest.id,
                userId: currentUserRequest.user_id,
                message: currentUserRequest.message || '',
                status: formatJoinRequestStatus(currentUserRequest.status),
                createdAt: currentUserRequest.created_at,
                updatedAt: currentUserRequest.updated_at,
                reviewedAt: currentUserRequest.reviewed_at || null,
            }
            : null,
        score: safeInteger(score),
        voteScore: safeInteger(voteScore),
        upvoteCount: safeNewsletterCount(upvoteCount),
        downvoteCount: safeNewsletterCount(downvoteCount),
        commentCount: safeNewsletterCount(commentCount),
        commentsCount: safeNewsletterCount(commentCount),
        userVote: userVote === 'up' || userVote === 'down' ? userVote : null,
    };
}

async function buildCollabPosts(postRows = [], collabRows = [], { requestUserId = null } = {}) {
    if (!postRows.length || !collabRows.length) return [];

    const collabByPostId = new Map((collabRows || []).map((row) => [String(row.post_id), row]));
    const mappedPosts = postRows
        .map(mapPost)
        .filter((post) => collabByPostId.has(String(post.id)));

    if (!mappedPosts.length) return [];

    const withTags = await attachTags(mappedPosts);
    const postIds = withTags.map((post) => post.id);
    const authorIds = [...new Set(withTags.map((post) => post.authorId).filter(Boolean))];

    const tagsByPostId = new Map(withTags.map((post) => [String(post.id), Array.isArray(post.tags) ? post.tags : []]));
    const authorMap = await getUsersByIds(authorIds);
    const skillsByPostId = await getCollabSkillsByPostIds(postIds);
    const memberCountByPostId = await getCollabMemberCountByPostIds(postIds);
    const requestSummary = await getCollabRequestSummaryByPostIds(postIds, requestUserId);
    const voteSummaryByPostId = await getVoteSummaryByPostIds(postIds, requestUserId);
    const commentCountByPostId = await getCommentCountByPostIds(postIds);

    return withTags.map((post) => {
        const collab = collabByPostId.get(String(post.id));
        const author = post.authorId ? (authorMap.get(post.authorId) || null) : null;
        const tags = tagsByPostId.get(String(post.id)) || [];
        const skills = skillsByPostId.get(String(post.id)) || [];
        const memberCount = memberCountByPostId.get(String(post.id)) || 0;
        const totalRequestCount = requestSummary.totalCountByPostId.get(String(post.id)) || 0;
        const pendingRequestCount = requestSummary.pendingCountByPostId.get(String(post.id)) || 0;
        const currentUserRequest = requestSummary.currentUserRequestByPostId.get(String(post.id)) || null;
        const voteSummary = voteSummaryByPostId.get(String(post.id)) || {
            score: 0,
            voteScore: 0,
            upvoteCount: 0,
            downvoteCount: 0,
            userVote: null,
        };
        const commentCount = commentCountByPostId.get(String(post.id)) || 0;

        return mapCollabPostRecord({
            post,
            collab,
            tags,
            skills,
            author,
            requestCount: totalRequestCount,
            pendingRequestCount,
            memberCount,
            currentUserRequest,
            score: voteSummary.score,
            voteScore: voteSummary.voteScore,
            upvoteCount: voteSummary.upvoteCount,
            downvoteCount: voteSummary.downvoteCount,
            commentCount,
            userVote: voteSummary.userVote,
        });
    });
}

async function getCollabPostById(postId, { requestUserId = null } = {}) {
    const normalizedPostId = normalizeText(postId);
    if (!normalizedPostId) return null;

    const meta = await getCollabPostMetaById(normalizedPostId);
    if (!meta) return null;

    const [post] = await buildCollabPosts([meta.postRow], [meta.collabRow], { requestUserId });
    return post || null;
}

function canEditCollabPost(meta, requestUser) {
    if (!meta?.postRow) return false;
    return Boolean(requestUser?.id) && String(meta.postRow.author_id) === String(requestUser.id);
}

async function closeCollabPostWhenFull(postId, collabRow) {
    const openings = Number.isFinite(Number(collabRow?.openings))
        ? Math.max(1, Math.trunc(Number(collabRow.openings)))
        : 1;
    const memberCountMap = await getCollabMemberCountByPostIds([postId]);
    const memberCount = memberCountMap.get(postId) || 0;
    const shouldClose = memberCount >= openings;

    if (shouldClose && normalizeText(collabRow?.status).toLowerCase() !== 'closed') {
        const nowIso = new Date().toISOString();
        const { error } = await supabase
            .from(CONFIG.tables.collabPosts)
            .update({ status: 'closed', updated_at: nowIso })
            .eq('post_id', postId);

        if (error) {
            throw error;
        }
    }

    return { memberCount, shouldClose };
}

async function getCollabMembers(postId) {
    const { data, error } = await supabase
        .from(CONFIG.tables.collabMemberships)
        .select('id, post_id, user_id, team_role, created_at')
        .eq('post_id', postId)
        .order('created_at', { ascending: true });

    if (error) {
        throw error;
    }

    const userIds = [...new Set((data || []).map((row) => row.user_id).filter(Boolean))];
    const userMap = await getUsersByIds(userIds);
    return (data || []).map((row) => mapCollabMembership(row, userMap));
}

async function getCollabJoinRequests(postId, { status = null } = {}) {
    let query = supabase
        .from(CONFIG.tables.collabJoinRequests)
        .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
        .eq('post_id', postId)
        .order('created_at', { ascending: false });

    if (status && status !== 'all') {
        query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) {
        throw error;
    }

    const userIds = [...new Set((data || []).map((row) => row.user_id).filter(Boolean))];
    const userMap = await getUsersByIds(userIds);
    return (data || []).map((row) => mapCollabJoinRequest(row, userMap));
}

function normalizeIsoTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function getTimestampForSort(value) {
    const normalized = normalizeIsoTimestamp(value);
    if (!normalized) return 0;
    return new Date(normalized).getTime();
}

function buildOwnerPendingJoinRequestNotification({
    requestRow,
    postRow,
    requesterUser = null,
}) {
    const createdAt = normalizeIsoTimestamp(requestRow?.created_at || requestRow?.updated_at);
    const postId = normalizeText(requestRow?.post_id);
    const postTitle = normalizeText(postRow?.title) || 'Collaboration post';
    const requesterName = normalizeText(requesterUser?.fullName) || normalizeText(requesterUser?.email) || 'A collaborator';
    const idStamp = createdAt || 'unknown';

    return {
        id: `collab-owner-pending-${requestRow.id}-${idStamp}`,
        source: 'api',
        kind: 'collab',
        eventType: 'join_request_received',
        requestStatus: 'PENDING',
        postId,
        postTitle,
        requestId: requestRow.id,
        createdAt,
        actorUserId: normalizeText(requestRow?.user_id) || null,
        actorName: requesterName,
        message: normalizeText(requestRow?.message) || null,
    };
}

function buildApplicantReviewNotification({
    requestRow,
    postRow,
    ownerUser = null,
}) {
    const normalizedStatus = normalizeText(requestRow?.status).toLowerCase();
    const requestStatus = normalizedStatus === 'accepted' ? 'ACCEPTED' : 'REJECTED';
    const createdAt = normalizeIsoTimestamp(requestRow?.reviewed_at || requestRow?.updated_at || requestRow?.created_at);
    const postId = normalizeText(requestRow?.post_id);
    const postTitle = normalizeText(postRow?.title) || 'Collaboration post';
    const ownerName = normalizeText(ownerUser?.fullName) || normalizeText(ownerUser?.email) || 'Post owner';
    const idStamp = createdAt || 'unknown';
    const eventType = requestStatus === 'ACCEPTED'
        ? 'join_request_accepted'
        : 'join_request_rejected';

    return {
        id: `collab-applicant-review-${requestRow.id}-${requestStatus.toLowerCase()}-${idStamp}`,
        source: 'api',
        kind: 'collab',
        eventType,
        requestStatus,
        postId,
        postTitle,
        requestId: requestRow.id,
        createdAt,
        actorUserId: normalizeText(postRow?.author_id) || null,
        actorName: ownerName,
        message: normalizeText(requestRow?.message) || null,
    };
}

async function getCollabNotificationsForUser(userId, { limit = COLLAB_NOTIFICATION_DEFAULT_LIMIT } = {}) {
    const normalizedUserId = normalizeText(userId);
    if (!normalizedUserId) return [];

    const safeLimit = parseIntInRange(limit, COLLAB_NOTIFICATION_DEFAULT_LIMIT, 1, COLLAB_NOTIFICATION_MAX_LIMIT);

    const { data: ownerPostRows, error: ownerPostError } = await supabase
        .from(CONFIG.tables.posts)
        .select('id, title, author_id')
        .eq('type', 'collab')
        .eq('author_id', normalizedUserId);

    if (ownerPostError) {
        throw ownerPostError;
    }

    const ownerPostIdList = (ownerPostRows || [])
        .map((row) => normalizeText(row?.id))
        .filter(Boolean);
    const ownerPostMap = new Map((ownerPostRows || []).map((row) => [String(row.id), row]));

    let ownerPendingRequests = [];
    if (ownerPostIdList.length) {
        const { data: pendingRows, error: pendingError } = await supabase
            .from(CONFIG.tables.collabJoinRequests)
            .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
            .in('post_id', ownerPostIdList)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(safeLimit);

        if (pendingError) {
            throw pendingError;
        }

        ownerPendingRequests = pendingRows || [];
    }

    const { data: applicantDecisionRows, error: applicantDecisionError } = await supabase
        .from(CONFIG.tables.collabJoinRequests)
        .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
        .eq('user_id', normalizedUserId)
        .in('status', ['accepted', 'rejected'])
        .order('reviewed_at', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false })
        .limit(safeLimit);

    if (applicantDecisionError) {
        throw applicantDecisionError;
    }

    const allPostIds = [
        ...new Set([
            ...ownerPostIdList,
            ...(applicantDecisionRows || []).map((row) => normalizeText(row?.post_id)).filter(Boolean),
        ]),
    ];

    const missingPostIds = allPostIds.filter((postId) => !ownerPostMap.has(postId));
    if (missingPostIds.length) {
        const { data: extraPostRows, error: extraPostError } = await supabase
            .from(CONFIG.tables.posts)
            .select('id, title, author_id')
            .in('id', missingPostIds);

        if (extraPostError) {
            throw extraPostError;
        }

        for (const row of extraPostRows || []) {
            ownerPostMap.set(String(row.id), row);
        }
    }

    const requesterIds = ownerPendingRequests
        .map((row) => normalizeText(row?.user_id))
        .filter(Boolean);
    const reviewerIds = (applicantDecisionRows || [])
        .map((row) => normalizeText(ownerPostMap.get(String(row.post_id))?.author_id))
        .filter(Boolean);
    const allUserIds = [...new Set([...requesterIds, ...reviewerIds])];
    const userMap = await getUsersByIds(allUserIds);

    const ownerNotifications = ownerPendingRequests.map((requestRow) => buildOwnerPendingJoinRequestNotification({
        requestRow,
        postRow: ownerPostMap.get(String(requestRow.post_id)) || null,
        requesterUser: userMap.get(String(requestRow.user_id)) || null,
    }));

    const applicantNotifications = (applicantDecisionRows || []).map((requestRow) => {
        const postRow = ownerPostMap.get(String(requestRow.post_id)) || null;
        const ownerId = normalizeText(postRow?.author_id);
        return buildApplicantReviewNotification({
            requestRow,
            postRow,
            ownerUser: ownerId ? (userMap.get(ownerId) || null) : null,
        });
    });

    const notifications = [...ownerNotifications, ...applicantNotifications]
        .filter((item) => Boolean(item?.id))
        .sort((a, b) => {
            const diff = getTimestampForSort(b.createdAt) - getTimestampForSort(a.createdAt);
            if (diff !== 0) return diff;
            return String(b.id).localeCompare(String(a.id));
        });

    return notifications.slice(0, safeLimit);
}

function buildEventVolunteerNotification({
    enrollmentRow,
    postRow,
    volunteerUser = null,
}) {
    const createdAt = normalizeIsoTimestamp(enrollmentRow?.created_at || enrollmentRow?.updated_at);
    const postId = normalizeText(enrollmentRow?.post_id);
    const postTitle = normalizeText(postRow?.title) || 'Event post';
    const submittedName = normalizeText(enrollmentRow?.full_name);
    const fallbackUserName = normalizeText(volunteerUser?.fullName) || normalizeText(volunteerUser?.email);
    const volunteerName = submittedName || fallbackUserName || 'A volunteer';
    const idStamp = createdAt || 'unknown';

    return {
        id: `event-owner-volunteer-${enrollmentRow.id}-${idStamp}`,
        source: 'api',
        kind: 'event',
        eventType: 'volunteer_enrollment_received',
        postId,
        postTitle,
        enrollmentId: enrollmentRow.id,
        createdAt,
        actorUserId: normalizeText(enrollmentRow?.user_id) || null,
        actorName: volunteerName,
        message: normalizeText(enrollmentRow?.reason) || null,
    };
}

async function getEventVolunteerNotificationsForUser(userId, { limit = EVENT_NOTIFICATION_DEFAULT_LIMIT } = {}) {
    const normalizedUserId = normalizeText(userId);
    if (!normalizedUserId) return [];

    const safeLimit = parseIntInRange(limit, EVENT_NOTIFICATION_DEFAULT_LIMIT, 1, EVENT_NOTIFICATION_MAX_LIMIT);

    const { data: ownerPostRows, error: ownerPostError } = await supabase
        .from(CONFIG.tables.posts)
        .select('id, title, author_id, type')
        .eq('author_id', normalizedUserId)
        .eq('type', 'EVENT');

    if (ownerPostError) {
        throw ownerPostError;
    }

    const ownerPostIds = (ownerPostRows || [])
        .map((row) => normalizeText(row?.id))
        .filter(Boolean);

    if (!ownerPostIds.length) {
        return [];
    }

    const postMap = new Map((ownerPostRows || []).map((row) => [String(row.id), row]));
    const { data: enrollmentRows, error: enrollmentError } = await supabase
        .from(CONFIG.tables.eventVolunteerEnrollments)
        .select('id, post_id, user_id, full_name, contact_info, reason, availability, notes, created_at, updated_at')
        .in('post_id', ownerPostIds)
        .order('created_at', { ascending: false })
        .limit(safeLimit);

    if (enrollmentError) {
        throw enrollmentError;
    }

    const volunteerIds = [...new Set((enrollmentRows || []).map((row) => normalizeText(row?.user_id)).filter(Boolean))];
    const userMap = await getUsersByIds(volunteerIds);

    return (enrollmentRows || [])
        .map((row) => buildEventVolunteerNotification({
            enrollmentRow: row,
            postRow: postMap.get(String(row.post_id)) || null,
            volunteerUser: userMap.get(String(row.user_id)) || null,
        }))
        .filter((item) => Boolean(item?.id))
        .sort((a, b) => {
            const diff = getTimestampForSort(b.createdAt) - getTimestampForSort(a.createdAt);
            if (diff !== 0) return diff;
            return String(b.id).localeCompare(String(a.id));
        })
        .slice(0, safeLimit);
}

function mapNewsletterSendRun(row) {
    if (!row) return null;

    return {
        id: row.id,
        issueId: row.issue_id,
        triggerType: row.trigger_type,
        initiatedBy: row.initiated_by || null,
        subject: row.subject || '',
        status: row.status || 'running',
        counts: {
            totalUsers: safeNewsletterCount(row.total_users),
            validEmails: safeNewsletterCount(row.valid_emails),
            skippedInvalidEmails: safeNewsletterCount(row.skipped_invalid_emails),
            skippedDuplicateEmails: safeNewsletterCount(row.skipped_duplicate_emails),
            attempted: safeNewsletterCount(row.attempted_count),
            sent: safeNewsletterCount(row.sent_count),
            failed: safeNewsletterCount(row.failed_count),
        },
        errorMessage: row.error_message || null,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    };
}

function mapNewsletterIssueRow(row, latestRun = null) {
    if (!row) return null;

    const contentSummary = row.content_summary && typeof row.content_summary === 'object'
        ? row.content_summary
        : {};
    const issueMonth = normalizeText(row.issue_month);
    const issueDate = normalizeText(row.issue_date);
    const issueMonthLabel = normalizeText(contentSummary.issueMonthLabel)
        || (issueMonth ? formatMonthYearLabelInTimeZone(`${issueMonth}-01T12:00:00Z`, CONFIG.newsletter.timeZone) : '');
    const issueDateLabel = normalizeText(contentSummary.issueDateLabel)
        || (issueDate ? formatIssueDateLabel(issueDate, CONFIG.newsletter.timeZone) : '');

    return {
        id: row.id,
        issueMonth: issueMonth || null,
        issueDate: issueDate || null,
        issueMonthLabel: issueMonthLabel || null,
        issueDateLabel: issueDateLabel || null,
        subject: row.subject || '',
        status: row.status || 'draft',
        publishedAt: row.published_at || null,
        lastGeneratedAt: row.last_generated_at || null,
        lastSentAt: row.last_sent_at || null,
        lastSendTrigger: row.last_send_trigger || null,
        lastSendInitiatedBy: row.last_send_initiated_by || null,
        lastSendCounts: row.last_send_counts && typeof row.last_send_counts === 'object'
            ? row.last_send_counts
            : {},
        lastError: row.last_error || null,
        automaticSendStartedAt: row.automatic_send_started_at || null,
        automaticSentAt: row.automatic_sent_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        contentSummary,
        latestRun: latestRun ? mapNewsletterSendRun(latestRun) : null,
    };
}

function buildNewsletterSubject(issueMonthLabel) {
    return `ICentral Academic Digest | ${issueMonthLabel || 'Monthly Issue'}`;
}

async function getLatestNewsletterSendRunForIssue(issueId) {
    const normalizedIssueId = normalizeText(issueId);
    if (!normalizedIssueId) return null;

    const { data, error } = await supabase
        .from(CONFIG.tables.newsletterSendRuns)
        .select('*')
        .eq('issue_id', normalizedIssueId)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data || null;
}

async function getNewsletterIssueByMonth(issueMonth, { includeLatestRun = false } = {}) {
    const normalizedIssueMonth = normalizeText(issueMonth);
    if (!normalizedIssueMonth) return null;

    const { data, error } = await supabase
        .from(CONFIG.tables.newsletterIssues)
        .select('*')
        .eq('issue_month', normalizedIssueMonth)
        .maybeSingle();

    if (error) {
        throw error;
    }

    if (!data) return null;
    if (!includeLatestRun) return data;

    const latestRun = await getLatestNewsletterSendRunForIssue(data.id);
    return {
        ...data,
        latestRun,
    };
}

function mapNewsletterSettingsRow(row) {
    return {
        autoSendEnabled: row ? Boolean(row.auto_send_enabled) : true,
        updatedAt: row?.updated_at || null,
        updatedBy: row?.updated_by || null,
    };
}

function buildNewsletterScheduleState(settingsRow) {
    const mapped = mapNewsletterSettingsRow(settingsRow);
    const envEnabled = Boolean(CONFIG.newsletter.scheduleEnabled);

    return {
        ...mapped,
        envEnabled,
        effectiveAutoSendEnabled: envEnabled && mapped.autoSendEnabled,
    };
}

async function getNewsletterSettingsRow() {
    const fetchSettingsRow = async () => {
        const { data, error } = await supabase
            .from(CONFIG.tables.newsletterSettings)
            .select('*')
            .eq('id', true)
            .maybeSingle();

        if (error) {
            throw error;
        }

        return data || null;
    };

    const existing = await fetchSettingsRow();
    if (existing) {
        return existing;
    }

    const nowIso = new Date().toISOString();
    const { error: insertError } = await supabase
        .from(CONFIG.tables.newsletterSettings)
        .insert({
            id: true,
            auto_send_enabled: true,
            updated_at: nowIso,
        });

    if (insertError && insertError.code !== '23505') {
        throw insertError;
    }

    const created = await fetchSettingsRow();
    if (!created) {
        throw new Error('Could not resolve newsletter settings.');
    }

    return created;
}

async function getNewsletterScheduleState() {
    const settingsRow = await getNewsletterSettingsRow();
    return buildNewsletterScheduleState(settingsRow);
}

async function updateNewsletterSettings({ autoSendEnabled, updatedBy = null }) {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
        .from(CONFIG.tables.newsletterSettings)
        .upsert({
            id: true,
            auto_send_enabled: Boolean(autoSendEnabled),
            updated_by: updatedBy || null,
            updated_at: nowIso,
        }, {
            onConflict: 'id',
        })
        .select('*')
        .single();

    if (error) {
        throw error;
    }

    return data;
}

async function ensureNewsletterIssuePlaceholder(issueContext) {
    const normalizedIssueMonth = normalizeText(issueContext?.issueMonth);
    const normalizedIssueDate = normalizeText(issueContext?.issueDate);
    if (!normalizedIssueMonth || !normalizedIssueDate) {
        throw new Error('Issue month and issue date are required for newsletter generation.');
    }

    const { error } = await supabase
        .from(CONFIG.tables.newsletterIssues)
        .insert({
            issue_month: normalizedIssueMonth,
            issue_date: normalizedIssueDate,
            subject: '',
            html_body: '',
            text_body: '',
            content_summary: {
                issueMonth: normalizedIssueMonth,
                issueMonthLabel: issueContext.issueMonthLabel || '',
                issueDate: normalizedIssueDate,
                issueDateLabel: issueContext.issueDateLabel || '',
                sections: {
                    achievement: [],
                    jobs: [],
                    events: [],
                    collabs: [],
                },
                counts: {
                    achievement: 0,
                    jobs: 0,
                    events: 0,
                    collabs: 0,
                    total: 0,
                },
            },
            last_send_counts: {},
            updated_at: issueContext.nowIso || new Date().toISOString(),
        });

    if (error && error.code !== '23505') {
        throw error;
    }

    const issueRow = await getNewsletterIssueByMonth(normalizedIssueMonth);
    if (!issueRow) {
        throw new Error(`Could not resolve newsletter issue for ${normalizedIssueMonth}.`);
    }

    return issueRow;
}

async function updateNewsletterIssueRow(issueId, updates = {}) {
    const { data, error } = await supabase
        .from(CONFIG.tables.newsletterIssues)
        .update(updates)
        .eq('id', issueId)
        .select('*')
        .single();

    if (error) {
        throw error;
    }

    return data;
}

async function createNewsletterSendRun(issueId, triggerType, initiatedBy, subject, nowIso) {
    const { data, error } = await supabase
        .from(CONFIG.tables.newsletterSendRuns)
        .insert({
            issue_id: issueId,
            trigger_type: triggerType,
            initiated_by: initiatedBy || null,
            subject: subject || '',
            status: 'running',
            started_at: nowIso,
            updated_at: nowIso,
        })
        .select('*')
        .single();

    if (error) {
        throw error;
    }

    return data;
}

async function finalizeNewsletterSendRun(runId, { status, counts, errorMessage = null, completedAt }) {
    const { data, error } = await supabase
        .from(CONFIG.tables.newsletterSendRuns)
        .update({
            total_users: safeNewsletterCount(counts?.totalUsers),
            valid_emails: safeNewsletterCount(counts?.validEmails),
            skipped_invalid_emails: safeNewsletterCount(counts?.skippedInvalidEmails),
            skipped_duplicate_emails: safeNewsletterCount(counts?.skippedDuplicateEmails),
            attempted_count: safeNewsletterCount(counts?.attempted),
            sent_count: safeNewsletterCount(counts?.sent),
            failed_count: safeNewsletterCount(counts?.failed),
            status,
            error_message: errorMessage,
            completed_at: completedAt,
            updated_at: completedAt,
        })
        .eq('id', runId)
        .select('*')
        .single();

    if (error) {
        throw error;
    }

    return data;
}

function sortByUpvotesThenNewest(a, b) {
    const upvoteDelta = safeNewsletterCount(b?.upvoteCount) - safeNewsletterCount(a?.upvoteCount);
    if (upvoteDelta !== 0) return upvoteDelta;

    const createdAtA = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const createdAtB = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (createdAtB !== createdAtA) return createdAtB - createdAtA;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
}

async function getPublishedPostsByTypes(types = []) {
    const normalizedTypes = new Set(
        (types || [])
            .map((type) => normalizeText(type).toUpperCase())
            .filter(Boolean)
    );
    if (normalizedTypes.size === 0) return [];

    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('*')
        .neq('status', 'archived');

    if (error) {
        throw error;
    }

    return (data || []).filter((row) => (
        normalizeText(row?.status).toLowerCase() === 'published'
        && normalizedTypes.has(normalizeText(row?.type).toUpperCase())
    ));
}

async function getPublishedCollabPostRows() {
    const { data, error } = await supabase
        .from(CONFIG.tables.posts)
        .select('*')
        .neq('status', 'archived');

    if (error) {
        throw error;
    }

    return (data || []).filter((row) => (
        normalizeText(row?.status).toLowerCase() === 'published'
        && isCollabType(row?.type)
    ));
}

async function getCollabRowsByPostIds(postIds = []) {
    if (!postIds.length) return [];

    const { data, error } = await supabase
        .from(CONFIG.tables.collabPosts)
        .select('*')
        .in('post_id', postIds);

    if (error) {
        throw error;
    }

    return data || [];
}

function buildAchievementNewsletterItem(post) {
    return {
        id: post.id,
        title: normalizeText(post.title) || 'Achievement highlight',
        summary: truncateNewsletterText(post.summary, 220) || 'A top-rated achievement update from the ICentral community.',
        authorName: normalizeText(post.authorName) || 'Community member',
        createdAt: post.createdAt || null,
        upvoteCount: safeNewsletterCount(post.upvoteCount),
        path: `/posts/${encodeURIComponent(String(post.id || ''))}`,
    };
}

function buildJobNewsletterItem(post) {
    const details = getJobDetailsForNewsletter(post);

    return {
        id: post.id,
        title: details.jobTitle,
        summary: truncateNewsletterText(details.jobDescription, 220) || 'A current job opportunity from the ICentral community.',
        companyName: details.companyName,
        salaryRange: details.salaryRange,
        deadline: post.expiresAt || null,
        createdAt: post.createdAt || null,
        upvoteCount: safeNewsletterCount(post.upvoteCount),
        path: `/posts/${encodeURIComponent(String(post.id || ''))}`,
    };
}

function buildEventNewsletterItem(post) {
    const details = getEventDetailsForNewsletter(post);

    return {
        id: post.id,
        title: normalizeText(post.title) || 'Event highlight',
        summary: truncateNewsletterText(post.summary || details.organizerNotes, 220) || 'A published event update from the ICentral community.',
        location: details.location,
        startsAt: details.startsAt || null,
        createdAt: post.createdAt || null,
        upvoteCount: safeNewsletterCount(post.upvoteCount),
        path: `/posts/${encodeURIComponent(String(post.id || ''))}`,
    };
}

function buildCollabNewsletterItem(post) {
    return {
        id: post.id,
        title: normalizeText(post.title) || 'Collaboration opportunity',
        summary: truncateNewsletterText(post.description || post.summary, 220) || 'A published collaboration post from the ICentral community.',
        category: normalizeText(post.category) || 'Academic collaboration',
        creatorName: normalizeText(post?.creator?.name) || normalizeText(post?.author?.fullName) || 'Community member',
        status: normalizeText(post.status) || '',
        openingsLeft: safeNewsletterCount(post.openingsLeft),
        deadline: post.deadline || post.joinUntil || null,
        createdAt: post.createdAt || null,
        upvoteCount: safeNewsletterCount(post.upvoteCount),
        path: `/collaborate/${encodeURIComponent(String(post.id || ''))}`,
    };
}

async function buildMonthlyNewsletterContentSummary(issueContext, existingIssue = null) {
    const issueDate = normalizeText(existingIssue?.issue_date) || normalizeText(issueContext.issueDate);
    const issueDateLabel = formatIssueDateLabel(issueDate, CONFIG.newsletter.timeZone);
    const [publishedRows, collabPostRows] = await Promise.all([
        getPublishedPostsByTypes(['ACHIEVEMENT', 'JOB', 'EVENT']),
        getPublishedCollabPostRows(),
    ]);

    const [enrichedPosts, collabRows] = await Promise.all([
        enrichPosts(publishedRows, { requestUserId: null }),
        getCollabRowsByPostIds(collabPostRows.map((row) => row.id)),
    ]);

    const achievements = enrichedPosts
        .filter((post) => normalizeText(post?.type).toUpperCase() === 'ACHIEVEMENT')
        .sort(sortByUpvotesThenNewest)
        .slice(0, 1)
        .map(buildAchievementNewsletterItem);

    const jobs = enrichedPosts
        .filter((post) => normalizeText(post?.type).toUpperCase() === 'JOB')
        .sort(sortByUpvotesThenNewest)
        .slice(0, 3)
        .map(buildJobNewsletterItem);

    const events = enrichedPosts
        .filter((post) => normalizeText(post?.type).toUpperCase() === 'EVENT')
        .sort(sortByUpvotesThenNewest)
        .slice(0, 3)
        .map(buildEventNewsletterItem);

    const collabs = collabPostRows.length > 0
        ? await buildCollabPosts(collabPostRows, collabRows, { requestUserId: null })
        : [];

    const collabItems = collabs
        .sort(sortByUpvotesThenNewest)
        .slice(0, 3)
        .map(buildCollabNewsletterItem);

    const contentSummary = {
        issueMonth: issueContext.issueMonth,
        issueMonthLabel: issueContext.issueMonthLabel,
        issueDate,
        issueDateLabel,
        generatedAt: issueContext.nowIso,
        sections: {
            achievement: achievements,
            jobs,
            events,
            collabs: collabItems,
        },
    };

    return {
        ...contentSummary,
        counts: summarizeNewsletterCounts(contentSummary),
    };
}

function buildNewsletterTemplateSections(contentSummary = {}) {
    const sections = contentSummary?.sections || {};

    return [
        {
            title: 'Achievement of the Month',
            emptyText: 'No published achievement posts are available for this issue.',
            items: (Array.isArray(sections.achievement) ? sections.achievement : []).map((item) => ({
                title: item.title,
                summary: item.summary,
                meta: [
                    item.authorName || 'Community member',
                    item.createdAt ? `Posted ${formatDateLabelInTimeZone(item.createdAt, CONFIG.newsletter.timeZone)}` : '',
                    `${safeNewsletterCount(item.upvoteCount)} upvote${safeNewsletterCount(item.upvoteCount) === 1 ? '' : 's'}`,
                ].filter(Boolean),
                href: buildAppUrl(item.path),
                linkLabel: 'Open achievement post',
            })),
        },
        {
            title: 'Job Opportunities',
            emptyText: 'No published job posts are available for this issue.',
            items: (Array.isArray(sections.jobs) ? sections.jobs : []).map((item) => ({
                title: item.title,
                summary: item.summary,
                meta: [
                    item.companyName,
                    `Salary: ${item.salaryRange || 'Not specified'}`,
                    item.deadline ? `Deadline ${formatDateTimeLabelInTimeZone(item.deadline, CONFIG.newsletter.timeZone)}` : '',
                    `${safeNewsletterCount(item.upvoteCount)} upvote${safeNewsletterCount(item.upvoteCount) === 1 ? '' : 's'}`,
                ].filter(Boolean),
                href: buildAppUrl(item.path),
                linkLabel: 'Open job post',
            })),
        },
        {
            title: 'Event Highlights',
            emptyText: 'No published event posts are available for this issue.',
            items: (Array.isArray(sections.events) ? sections.events : []).map((item) => ({
                title: item.title,
                summary: item.summary,
                meta: [
                    item.startsAt ? `Event date ${formatDateTimeLabelInTimeZone(item.startsAt, CONFIG.newsletter.timeZone)}` : '',
                    item.location || 'Location to be announced',
                    `${safeNewsletterCount(item.upvoteCount)} upvote${safeNewsletterCount(item.upvoteCount) === 1 ? '' : 's'}`,
                ].filter(Boolean),
                href: buildAppUrl(item.path),
                linkLabel: 'Open event post',
            })),
        },
        {
            title: 'Collaboration Opportunities',
            emptyText: 'No published collaboration posts are available for this issue.',
            items: (Array.isArray(sections.collabs) ? sections.collabs : []).map((item) => ({
                title: item.title,
                summary: item.summary,
                meta: [
                    item.category || 'Academic collaboration',
                    item.creatorName || 'Community member',
                    item.status ? `Status: ${item.status}` : '',
                    Number.isFinite(Number(item.openingsLeft)) ? `Openings left: ${safeNewsletterCount(item.openingsLeft)}` : '',
                    item.deadline ? `Deadline ${formatDateTimeLabelInTimeZone(item.deadline, CONFIG.newsletter.timeZone)}` : '',
                    `${safeNewsletterCount(item.upvoteCount)} upvote${safeNewsletterCount(item.upvoteCount) === 1 ? '' : 's'}`,
                ].filter(Boolean),
                href: buildAppUrl(item.path),
                linkLabel: 'Open collaboration post',
            })),
        },
    ];
}

function buildNewsletterBodies(contentSummary) {
    const counts = summarizeNewsletterCounts(contentSummary);
    const introduction = `Here is the ${contentSummary.issueMonthLabel} academic roundup from ICentral. `
        + `${counts.total} top published community post${counts.total === 1 ? '' : 's'} are highlighted across achievements, jobs, events, and collaboration opportunities.`;

    return buildNewsletterEmailBodies({
        subject: buildNewsletterSubject(contentSummary.issueMonthLabel),
        issueMonthLabel: contentSummary.issueMonthLabel,
        issueDateLabel: contentSummary.issueDateLabel,
        introduction,
        sections: buildNewsletterTemplateSections(contentSummary),
    });
}

function isSyntacticallyValidEmail(value) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized || normalized.length > 254) {
        return false;
    }

    if (/\s/.test(normalized) || normalized.includes('..')) {
        return false;
    }

    const atIndex = normalized.indexOf('@');
    if (atIndex <= 0 || atIndex !== normalized.lastIndexOf('@') || atIndex === normalized.length - 1) {
        return false;
    }

    const localPart = normalized.slice(0, atIndex);
    const domain = normalized.slice(atIndex + 1);
    if (!localPart || !domain || localPart.length > 64 || domain.length > 253) {
        return false;
    }

    if (localPart.startsWith('.') || localPart.endsWith('.')) {
        return false;
    }

    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart)) {
        return false;
    }

    const labels = domain.split('.');
    if (labels.length < 2) {
        return false;
    }

    for (const label of labels) {
        if (!label || label.length > 63) {
            return false;
        }
        if (label.startsWith('-') || label.endsWith('-')) {
            return false;
        }
        if (!/^[a-z0-9-]+$/i.test(label)) {
            return false;
        }
    }

    const normalizedDomain = labels.join('.');
    const tld = labels[labels.length - 1];
    if (!/^[a-z]{2,63}$/i.test(tld)) {
        return false;
    }

    if (
        NEWSLETTER_BLOCKED_EMAIL_DOMAINS.has(normalizedDomain)
        || NEWSLETTER_BLOCKED_EMAIL_TLDS.has(tld)
    ) {
        return false;
    }

    return true;
}

async function getNewsletterRecipients({ recipientIds = null } = {}) {
    const normalizedRecipientIds = Array.isArray(recipientIds) ? normalizeIdList(recipientIds) : null;

    if (Array.isArray(recipientIds) && normalizedRecipientIds.length === 0) {
        return {
            totalUsers: 0,
            validRecipients: [],
            validEmails: 0,
            skippedInvalidEmails: 0,
            skippedDuplicateEmails: 0,
        };
    }

    let query = supabase
        .from(CONFIG.tables.users)
        .select('id, email, full_name');

    if (Array.isArray(normalizedRecipientIds)) {
        query = query.in('id', normalizedRecipientIds);
    }

    const { data, error } = await query;

    if (error) {
        throw error;
    }

    const rows = Array.isArray(data) ? data : [];
    const seenEmails = new Set();
    const validRecipients = [];
    let skippedInvalidEmails = 0;
    let skippedDuplicateEmails = 0;

    for (const row of rows) {
        const normalizedEmail = normalizeText(row?.email).toLowerCase();

        if (!normalizedEmail || !isSyntacticallyValidEmail(normalizedEmail)) {
            skippedInvalidEmails += 1;
            continue;
        }

        if (seenEmails.has(normalizedEmail)) {
            skippedDuplicateEmails += 1;
            continue;
        }

        seenEmails.add(normalizedEmail);
        validRecipients.push({
            id: row.id,
            email: normalizedEmail,
            fullName: normalizeText(row?.full_name) || null,
        });
    }

    validRecipients.sort((a, b) => {
        const labelA = String(a?.fullName || a?.email || '').toLowerCase();
        const labelB = String(b?.fullName || b?.email || '').toLowerCase();
        const labelComparison = labelA.localeCompare(labelB);
        if (labelComparison !== 0) return labelComparison;
        return String(a?.email || '').localeCompare(String(b?.email || ''));
    });

    return {
        totalUsers: rows.length,
        validRecipients,
        validEmails: validRecipients.length,
        skippedInvalidEmails,
        skippedDuplicateEmails,
    };
}

function determineNewsletterRunStatus(counts = {}) {
    const attempted = safeNewsletterCount(counts.attempted);
    const sent = safeNewsletterCount(counts.sent);
    const failed = safeNewsletterCount(counts.failed);

    if (failed > 0 && sent > 0) return 'partial';
    if (failed > 0) return 'failed';
    if (attempted === 0) return 'skipped';
    return 'sent';
}

function isNewsletterIssueActivelySending(issueRow) {
    if (normalizeText(issueRow?.status).toLowerCase() !== 'sending') {
        return false;
    }

    const updatedAtMs = issueRow?.updated_at
        ? new Date(issueRow.updated_at).getTime()
        : issueRow?.updatedAt
            ? new Date(issueRow.updatedAt).getTime()
            : NaN;

    if (!Number.isFinite(updatedAtMs)) {
        return true;
    }

    return (Date.now() - updatedAtMs) < (30 * 60 * 1000);
}

async function sendNewsletterToRecipients({ subject, html, text, recipientSet }) {
    const transporter = getNewsletterTransporter();
    const resolvedRecipientSet = recipientSet || await getNewsletterRecipients();
    let attempted = 0;
    let sent = 0;
    let failed = 0;

    for (const recipient of resolvedRecipientSet.validRecipients) {
        attempted += 1;

        try {
            await transporter.sendMail({
                from: `"${CONFIG.newsletter.smtpFromName}" <${CONFIG.newsletter.smtpFromEmail}>`,
                to: recipient.email,
                subject,
                html,
                text,
            });
            sent += 1;
        } catch (error) {
            failed += 1;
            console.error(`Newsletter send failed for ${recipient.email}:`, error.message);
        }
    }

    return {
        totalUsers: resolvedRecipientSet.totalUsers,
        validEmails: resolvedRecipientSet.validEmails,
        skippedInvalidEmails: resolvedRecipientSet.skippedInvalidEmails,
        skippedDuplicateEmails: resolvedRecipientSet.skippedDuplicateEmails,
        attempted,
        sent,
        failed,
    };
}

async function claimAutomaticNewsletterIssue(issueContext) {
    const issueRow = await ensureNewsletterIssuePlaceholder(issueContext);

    const { data, error } = await supabase
        .from(CONFIG.tables.newsletterIssues)
        .update({
            automatic_send_started_at: issueContext.nowIso,
            status: 'sending',
            updated_at: issueContext.nowIso,
            last_error: null,
        })
        .eq('id', issueRow.id)
        .is('automatic_sent_at', null)
        .is('automatic_send_started_at', null)
        .is('published_at', null)
        .select('*');

    if (error) {
        throw error;
    }

    return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function buildNewsletterNotificationTitle(issue) {
    return `${issue.issueMonthLabel || issue.issueMonth || 'Current'} newsletter published`;
}

function buildNewsletterNotificationMessage(issue) {
    const counts = summarizeNewsletterCounts(issue?.contentSummary || {});
    const parts = [];

    if (counts.achievement > 0) parts.push(`${counts.achievement} achievement`);
    if (counts.jobs > 0) parts.push(`${counts.jobs} job${counts.jobs === 1 ? '' : 's'}`);
    if (counts.events > 0) parts.push(`${counts.events} event${counts.events === 1 ? '' : 's'}`);
    if (counts.collabs > 0) parts.push(`${counts.collabs} collaboration${counts.collabs === 1 ? '' : 's'}`);

    if (parts.length === 0) {
        return 'A new monthly academic digest was published from current community activity.';
    }

    return `${parts.join(', ')} highlighted in this issue.`;
}

function mapNewsletterIssueToNotification(issueRow) {
    const issue = mapNewsletterIssueRow(issueRow);
    if (!issue?.id) return null;

    return {
        id: `newsletter-issue-${issue.id}`,
        source: 'api',
        kind: 'newsletter',
        issueId: issue.id,
        issueMonth: issue.issueMonth,
        title: buildNewsletterNotificationTitle(issue),
        message: buildNewsletterNotificationMessage(issue),
        createdAt: issue.publishedAt || issue.lastSentAt || issue.createdAt,
    };
}

async function getNewsletterNotifications({ limit = NEWSLETTER_NOTIFICATION_DEFAULT_LIMIT } = {}) {
    const safeLimit = parseIntInRange(
        limit,
        NEWSLETTER_NOTIFICATION_DEFAULT_LIMIT,
        1,
        NEWSLETTER_NOTIFICATION_MAX_LIMIT
    );

    const { data, error } = await supabase
        .from(CONFIG.tables.newsletterIssues)
        .select('*')
        .not('published_at', 'is', null)
        .order('published_at', { ascending: false })
        .limit(safeLimit);

    if (error) {
        throw error;
    }

    return (data || [])
        .map(mapNewsletterIssueToNotification)
        .filter(Boolean);
}

async function sendCurrentMonthNewsletter({
    triggerType = 'manual',
    initiatedBy = null,
    lockedIssueRow = null,
    recipientIds = null,
} = {}) {
    if (!isNewsletterEmailConfigured()) {
        const error = new Error('Newsletter email delivery is not configured.');
        error.status = 503;
        error.requiredEnv = ['SMTP_HOST', 'SMTP_FROM_EMAIL'];
        throw error;
    }

    const normalizedRecipientIds = Array.isArray(recipientIds) ? normalizeIdList(recipientIds) : null;
    if (Array.isArray(recipientIds) && normalizedRecipientIds.length === 0) {
        const error = new Error('Select at least one recipient.');
        error.status = 400;
        throw error;
    }

    const recipientSet = await getNewsletterRecipients(
        Array.isArray(normalizedRecipientIds)
            ? { recipientIds: normalizedRecipientIds }
            : {}
    );
    if (Array.isArray(normalizedRecipientIds) && recipientSet.validRecipients.length === 0) {
        const error = new Error('No valid recipients matched the selected users.');
        error.status = 400;
        throw error;
    }

    const issueContext = getNewsletterIssueContext(new Date());
    let issueRow = lockedIssueRow || await ensureNewsletterIssuePlaceholder(issueContext);
    let sendRun = null;

    const effectiveIssueDate = normalizeText(issueRow?.issue_date) || issueContext.issueDate;
    const contentSummary = await buildMonthlyNewsletterContentSummary({
        ...issueContext,
        issueDate: effectiveIssueDate,
        issueDateLabel: formatIssueDateLabel(effectiveIssueDate, CONFIG.newsletter.timeZone),
    }, issueRow);
    const subject = buildNewsletterSubject(contentSummary.issueMonthLabel);
    const bodies = buildNewsletterBodies(contentSummary);

    issueRow = await updateNewsletterIssueRow(issueRow.id, {
        issue_date: effectiveIssueDate,
        subject,
        html_body: bodies.html,
        text_body: bodies.text,
        content_summary: contentSummary,
        status: 'sending',
        last_generated_at: issueContext.nowIso,
        updated_at: issueContext.nowIso,
        last_error: null,
    });

    try {
        sendRun = await createNewsletterSendRun(issueRow.id, triggerType, initiatedBy, subject, issueContext.nowIso);
        const counts = await sendNewsletterToRecipients({
            subject,
            html: bodies.html,
            text: bodies.text,
            recipientSet,
        });
        const finalStatus = determineNewsletterRunStatus(counts);
        const completedAt = new Date().toISOString();
        const publishable = finalStatus === 'sent' || finalStatus === 'partial' || finalStatus === 'skipped';
        const issueUpdatePayload = {
            issue_date: effectiveIssueDate,
            subject,
            html_body: bodies.html,
            text_body: bodies.text,
            content_summary: contentSummary,
            status: finalStatus,
            last_generated_at: issueContext.nowIso,
            last_sent_at: publishable ? completedAt : issueRow.last_sent_at,
            last_send_trigger: triggerType,
            last_send_initiated_by: initiatedBy || null,
            last_send_counts: counts,
            last_error: finalStatus === 'partial' ? `${safeNewsletterCount(counts.failed)} recipient email(s) failed.` : null,
            published_at: issueRow.published_at || (publishable ? completedAt : null),
            automatic_sent_at: triggerType === 'automatic' && publishable
                ? completedAt
                : (issueRow.automatic_sent_at || null),
            updated_at: completedAt,
        };

        if (triggerType !== 'automatic') {
            issueUpdatePayload.automatic_send_started_at = issueRow.automatic_send_started_at || null;
        }

        issueRow = await updateNewsletterIssueRow(issueRow.id, issueUpdatePayload);
        sendRun = await finalizeNewsletterSendRun(sendRun.id, {
            status: finalStatus,
            counts,
            completedAt,
        });

        return {
            skipped: false,
            issue: mapNewsletterIssueRow(issueRow, sendRun),
            run: mapNewsletterSendRun(sendRun),
            counts,
        };
    } catch (error) {
        const failedAt = new Date().toISOString();
        const failedCounts = {
            totalUsers: 0,
            validEmails: 0,
            skippedInvalidEmails: 0,
            skippedDuplicateEmails: 0,
            attempted: 0,
            sent: 0,
            failed: 0,
        };

        issueRow = await updateNewsletterIssueRow(issueRow.id, {
            issue_date: effectiveIssueDate,
            subject,
            html_body: bodies.html,
            text_body: bodies.text,
            content_summary: contentSummary,
            status: 'failed',
            last_generated_at: issueContext.nowIso,
            last_send_trigger: triggerType,
            last_send_initiated_by: initiatedBy || null,
            last_send_counts: failedCounts,
            last_error: error.message || 'Newsletter delivery failed.',
            updated_at: failedAt,
        }).catch(() => issueRow);

        if (sendRun?.id) {
            await finalizeNewsletterSendRun(sendRun.id, {
                status: 'failed',
                counts: failedCounts,
                errorMessage: error.message || 'Newsletter delivery failed.',
                completedAt: failedAt,
            }).catch(() => null);
        }

        throw error;
    }
}

async function maybeRunAutomaticMonthlyNewsletter() {
    if (!CONFIG.newsletter.scheduleEnabled || !isSupabaseConfigured()) {
        return { skipped: true, reason: 'Newsletter scheduling disabled.' };
    }

    if (!isNewsletterEmailConfigured()) {
        return { skipped: true, reason: 'Newsletter email delivery is not configured.' };
    }

    const scheduleState = await getNewsletterScheduleState();
    if (!scheduleState.effectiveAutoSendEnabled) {
        return {
            skipped: true,
            reason: scheduleState.envEnabled
                ? 'Newsletter auto-send is disabled by moderators.'
                : 'Newsletter scheduling disabled.',
        };
    }

    const issueContext = getNewsletterIssueContext(new Date());
    if (issueContext.day !== 1) {
        return { skipped: true, reason: 'Automatic newsletter runs only on the first day of the month.' };
    }

    const lockedIssueRow = await claimAutomaticNewsletterIssue(issueContext);
    if (!lockedIssueRow) {
        return { skipped: true, reason: `Automatic newsletter for ${issueContext.issueMonth} has already been processed.` };
    }

    return sendCurrentMonthNewsletter({
        triggerType: 'automatic',
        initiatedBy: null,
        lockedIssueRow,
    });
}

app.get('/', (req, res) => {
    return res.json({
        health: 'Post service OK',
        supabaseConfigured: isSupabaseConfigured(),
        schema: CONFIG.schema,
        endpoints: [
            'GET /feed',
            'GET /search',
            'POST /collab-posts',
            'GET /collab-posts',
            'GET /collab-posts/:id',
            'PATCH /collab-posts/:id',
            'PATCH /collab-posts/:id/status',
            'POST /collab-posts/:id/join-requests',
            'GET /collab-posts/:id/join-requests',
            'PATCH /join-requests/:id',
            'GET /collab-posts/:id/members',
            'GET /collab-notifications',
            'GET /event-notifications',
            'GET /newsletter/settings',
            'PATCH /newsletter/settings',
            'GET /newsletter/current',
            'GET /newsletter/recipients',
            'POST /newsletter/send',
            'GET /newsletter/notifications',
            'GET /posts/:id',
            'POST /posts',
            'PATCH /posts/:id',
            'DELETE /posts/:id',
            'POST /posts/:id/vote',
            'GET /posts/:id/volunteers',
            'POST /posts/:id/volunteers',
            'GET /posts/:id/comments',
            'POST /posts/:id/comments',
            'PATCH /posts/:id/comments/:commentId',
            'DELETE /posts/:id/comments/:commentId',
            'GET /tags',
            'POST /tags',
        ],
    });
});

app.get('/health', (req, res) => {
    return res.json({
        service: 'post-service',
        status: 'ok',
        supabaseConfigured: isSupabaseConfigured(),
        searchDbConfigured: isSearchDbConfigured(),
    });
});

app.post('/internal/archive-expired', ensureDb, async (req, res) => {
    try {
        const result = await archiveExpiredPosts();
        return res.json({ message: 'Archive sweep completed', ...result });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/feed', ensureDb, async (req, res) => {
    try {
        const requestUser = getRequestUser(req);
        const archiveResult = await archiveExpiredPosts().catch(() => ({ archivedCount: 0 }));
        const limit = parseIntInRange(req.query.limit, CONFIG.feedDefaultLimit, 1, CONFIG.feedMaxLimit);
        const offset = parseIntInRange(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const sort = normalizeFeedSortOption(req.query.sort);
        const cursorResult = decodeFeedCursor(req.query.cursor);
        if (cursorResult.error) {
            return res.status(400).json({ error: cursorResult.error });
        }
        const cursor = cursorResult.value;
        const includeArchived = parseBool(req.query.includeArchived, false);
        const pinnedOnly = parseBool(req.query.pinnedOnly, false);
        const status = typeof req.query.status === 'string'
            ? req.query.status.trim().toLowerCase()
            : '';
        const type = normalizeText(req.query.type);
        const authorId = normalizeText(req.query.authorId || req.query.author_id);
        const tag = req.query.tag;
        const search = sanitizeSearchTerm(req.query.search || '');
        const effectiveOffset = cursor ? cursor.offset : offset;

        if (cursor && !authorId) {
            return res.status(400).json({
                error: 'cursor can only be used together with authorId',
            });
        }
        if (cursor && cursor.authorId && authorId && cursor.authorId !== authorId) {
            return res.status(400).json({
                error: 'cursor does not match requested authorId',
            });
        }
        if (cursor && cursor.sort && cursor.sort !== sort) {
            return res.status(400).json({
                error: 'cursor does not match requested sort',
            });
        }

        const tagFilteredPostIds = await resolveTagFilterPostIds(tag);
        if (Array.isArray(tagFilteredPostIds) && !tagFilteredPostIds.length) {
            return res.json({
                data: [],
                items: [],
                pagination: { limit, offset: effectiveOffset, total: 0, nextCursor: null },
                nextCursor: null,
                meta: {
                    archivedDuringRequest: archiveResult.archivedCount || 0,
                    sort,
                    authorId: authorId || null,
                },
            });
        }

        if (authorId) {
            let authorQuery = supabase
                .from(CONFIG.tables.posts)
                .select('*')
                .eq('author_id', authorId);

            if (status && status !== 'all') {
                authorQuery = authorQuery.eq('status', status);
            } else if (!status && !includeArchived) {
                authorQuery = authorQuery.eq('status', 'published');
            } else if (status === 'all' && !includeArchived) {
                authorQuery = authorQuery.neq('status', 'archived');
            }

            if (pinnedOnly) {
                authorQuery = authorQuery.eq('pinned', true);
            }

            if (type) {
                if (isCollabType(type)) {
                    authorQuery = authorQuery.in('type', ['collab', 'COLLAB']);
                } else {
                    authorQuery = authorQuery.eq('type', type);
                }
            }

            if (tagFilteredPostIds) {
                authorQuery = authorQuery.in('id', tagFilteredPostIds);
            }

            if (search) {
                authorQuery = authorQuery.or(`title.ilike.%${search}%,summary.ilike.%${search}%`);
            }

            const { data: authorRows, error: authorRowsError } = await authorQuery;
            if (authorRowsError) {
                throw authorRowsError;
            }

            const enrichedRows = await enrichPosts(authorRows || [], { requestUserId: requestUser?.id || null });
            const sortedRows = sortFeedItems(enrichedRows, sort);
            const paginatedRows = sortedRows.slice(effectiveOffset, effectiveOffset + limit);
            const nextOffset = effectiveOffset + paginatedRows.length;
            const nextCursor = nextOffset < sortedRows.length
                ? encodeFeedCursor({ offset: nextOffset, authorId, sort })
                : null;

            return res.json({
                data: paginatedRows,
                items: paginatedRows,
                pagination: {
                    limit,
                    offset: effectiveOffset,
                    total: sortedRows.length,
                    nextCursor,
                },
                nextCursor,
                meta: {
                    archivedDuringRequest: archiveResult.archivedCount || 0,
                    sort,
                    authorId,
                },
            });
        }

        let query = supabase
            .from(CONFIG.tables.posts)
            .select('*', { count: 'exact' })
            .order('pinned', { ascending: false })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status && status !== 'all') {
            query = query.eq('status', status);
        } else if (!status && !includeArchived) {
            query = query.eq('status', 'published');
        } else if (status === 'all' && !includeArchived) {
            query = query.neq('status', 'archived');
        }

        if (pinnedOnly) {
            query = query.eq('pinned', true);
        }

        if (type) {
            if (isCollabType(type)) {
                query = query.in('type', ['collab', 'COLLAB']);
            } else {
                query = query.eq('type', type);
            }
        }

        if (tagFilteredPostIds) {
            query = query.in('id', tagFilteredPostIds);
        }

        if (search) {
            query = query.or(`title.ilike.%${search}%,summary.ilike.%${search}%`);
        }

        const { data: rows, error, count } = await query;
        if (error) {
            throw error;
        }

        const data = await enrichPosts(rows || [], { requestUserId: requestUser?.id || null });

        return res.json({
            data,
            pagination: {
                limit,
                offset,
                total: count ?? data.length,
                nextCursor: null,
            },
            nextCursor: null,
            meta: {
                archivedDuringRequest: archiveResult.archivedCount || 0,
            },
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

async function handleSearchPosts(req, res) {
    try {
        const requestUser = getRequestUser(req);
        const payload = parseSearchRequest(req.query);

        if (payload.errors.length) {
            return res.status(400).json({
                error: 'Validation failed',
                details: payload.errors,
            });
        }

        const result = await searchPosts({
            q: payload.q,
            limit: payload.limit,
            cursor: payload.cursor,
            requestUserId: requestUser?.id || null,
        });

        return res.json(result);
    } catch (error) {
        if (error?.code === '42601' || /tsquery/i.test(String(error?.message || ''))) {
            return res.status(400).json({ error: 'Invalid search query' });
        }
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(error?.status || 500).json({
            error: error?.expose ? error.message : formatSupabaseError(error),
        });
    }
}

app.get(['/search', '/posts/search'], ensureDb, ensureSearchDb, handleSearchPosts);

app.post('/collab-posts', ensureDb, ensureAuthenticated, async (req, res) => {
    let createdPostId = null;

    try {
        const payload = parseCollabPostPayload(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const nowIso = new Date().toISOString();
        const postInsertPayload = {
            type: 'collab',
            title: payload.postFields.title,
            summary: payload.postFields.summary,
            author_id: req.requestUser.id,
            status: 'published',
            pinned: false,
            updated_at: nowIso,
        };

        const { data: createdPost, error: postInsertError } = await supabase
            .from(CONFIG.tables.posts)
            .insert(postInsertPayload)
            .select('*')
            .single();

        if (postInsertError) {
            throw postInsertError;
        }

        createdPostId = createdPost.id;

        const collabInsertPayload = {
            post_id: createdPost.id,
            category: payload.collabFields.category,
            description: payload.collabFields.description,
            mode: payload.collabFields.mode,
            time_commitment_hours_per_week: payload.collabFields.time_commitment_hours_per_week,
            duration: payload.collabFields.duration,
            openings: payload.collabFields.openings,
            preferred_background: payload.collabFields.preferred_background || null,
            deadline: payload.collabFields.deadline ?? null,
            status: 'open',
            contact_method: payload.collabFields.contact_method || null,
            updated_at: nowIso,
        };

        const { error: collabInsertError } = await supabase
            .from(CONFIG.tables.collabPosts)
            .insert(collabInsertPayload);

        if (collabInsertError) {
            throw collabInsertError;
        }

        await replaceCollabSkills(createdPost.id, payload.requiredSkills);

        if (payload.tagsProvided) {
            await replacePostTags(createdPost.id, payload.tagIds, payload.tagNames);
        }

        const fullPost = await getCollabPostById(createdPost.id, { requestUserId: req.requestUser.id });

        return res.status(201).json({
            message: 'Collaboration post created',
            data: fullPost,
        });
    } catch (error) {
        if (createdPostId) {
            await supabase
                .from(CONFIG.tables.posts)
                .delete()
                .eq('id', createdPostId)
                .catch(() => null);
        }
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/collab-posts', ensureDb, async (req, res) => {
    try {
        const requestUser = getRequestUser(req);
        const limit = parseIntInRange(req.query.limit, COLLAB_DEFAULT_LIMIT, 1, COLLAB_MAX_LIMIT);
        const offset = parseIntInRange(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const sort = normalizeCollabSort(req.query.sort);
        const categoryFilter = normalizeText(req.query.category);
        const authorIdFilter = normalizeText(req.query.author || req.query.authorId || req.query.author_id);
        const queryText = sanitizeSearchTerm(req.query.q || req.query.search || '');
        const skillFilter = normalizeText(req.query.skill || req.query.skillTag || req.query.requiredSkill);

        const modeResult = normalizeCollabMode(req.query.mode, { allowEmpty: true, fieldName: 'mode' });
        if (modeResult.error) {
            return res.status(400).json({ error: modeResult.error });
        }

        const statusResult = normalizeCollabStatus(req.query.status, { allowEmpty: true, fieldName: 'status' });
        if (statusResult.error) {
            return res.status(400).json({ error: statusResult.error });
        }

        let postQuery = supabase
            .from(CONFIG.tables.posts)
            .select('*')
            .eq('type', 'collab')
            .neq('status', 'archived');

        if (authorIdFilter) {
            postQuery = postQuery.eq('author_id', authorIdFilter);
        }

        const { data: postRows, error: postRowsError } = await postQuery;
        if (postRowsError) {
            throw postRowsError;
        }

        if (!Array.isArray(postRows) || postRows.length === 0) {
            return res.json({
                data: [],
                items: [],
                pagination: {
                    limit,
                    offset,
                    total: 0,
                    nextCursor: null,
                },
                nextCursor: null,
                meta: {
                    sort,
                    filters: {
                        category: categoryFilter || null,
                        mode: modeResult.value || null,
                        status: statusResult.value || null,
                        skill: skillFilter || null,
                        authorId: authorIdFilter || null,
                        q: queryText || null,
                    },
                },
            });
        }

        const postIds = postRows.map((row) => row.id);
        let collabQuery = supabase
            .from(CONFIG.tables.collabPosts)
            .select('*')
            .in('post_id', postIds);

        if (categoryFilter) {
            collabQuery = collabQuery.eq('category', categoryFilter);
        }

        if (modeResult.value) {
            collabQuery = collabQuery.eq('mode', modeResult.value);
        }

        if (statusResult.value) {
            collabQuery = collabQuery.eq('status', statusResult.value);
        }

        const { data: collabRows, error: collabRowsError } = await collabQuery;
        if (collabRowsError) {
            throw collabRowsError;
        }

        if (!Array.isArray(collabRows) || collabRows.length === 0) {
            return res.json({
                data: [],
                items: [],
                pagination: {
                    limit,
                    offset,
                    total: 0,
                    nextCursor: null,
                },
                nextCursor: null,
                meta: {
                    sort,
                    filters: {
                        category: categoryFilter || null,
                        mode: modeResult.value || null,
                        status: statusResult.value || null,
                        skill: skillFilter || null,
                        authorId: authorIdFilter || null,
                        q: queryText || null,
                    },
                },
            });
        }

        let collabPosts = await buildCollabPosts(postRows, collabRows, { requestUserId: requestUser?.id || null });

        const normalizedQuery = normalizeText(queryText).toLowerCase();
        if (normalizedQuery) {
            collabPosts = collabPosts.filter((post) => {
                const searchable = [
                    post.title,
                    post.summary,
                    post.description,
                    post.category,
                    post.preferredBackground,
                    post.contactMethod,
                    ...(Array.isArray(post.requiredSkills) ? post.requiredSkills : []),
                    ...(Array.isArray(post.tags) ? post.tags : []),
                ]
                    .join(' ')
                    .toLowerCase();
                return searchable.includes(normalizedQuery);
            });
        }

        const normalizedSkillFilter = skillFilter.toLowerCase();
        if (normalizedSkillFilter) {
            collabPosts = collabPosts.filter((post) => {
                const skillValues = [
                    ...(Array.isArray(post.requiredSkills) ? post.requiredSkills : []),
                    ...(Array.isArray(post.tags) ? post.tags : []),
                ];
                return skillValues.some((skill) => String(skill).toLowerCase().includes(normalizedSkillFilter));
            });
        }

        collabPosts.sort((a, b) => {
            if (sort === 'deadline') {
                const aDeadline = a.joinUntil ? new Date(a.joinUntil).getTime() : Number.POSITIVE_INFINITY;
                const bDeadline = b.joinUntil ? new Date(b.joinUntil).getTime() : Number.POSITIVE_INFINITY;
                if (aDeadline !== bDeadline) return aDeadline - bDeadline;
            }

            const aCreatedAt = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bCreatedAt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            if (aCreatedAt !== bCreatedAt) return bCreatedAt - aCreatedAt;
            return String(b.id).localeCompare(String(a.id));
        });

        const paginated = collabPosts.slice(offset, offset + limit);

        return res.json({
            data: paginated,
            items: paginated,
            pagination: {
                limit,
                offset,
                total: collabPosts.length,
                nextCursor: null,
            },
            nextCursor: null,
            meta: {
                sort,
                filters: {
                    category: categoryFilter || null,
                    mode: modeResult.value || null,
                    status: statusResult.value || null,
                    skill: skillFilter || null,
                    authorId: authorIdFilter || null,
                    q: queryText || null,
                },
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/collab-posts/:id', ensureDb, async (req, res) => {
    try {
        const requestUser = getRequestUser(req);
        const post = await getCollabPostById(req.params.id, { requestUserId: requestUser?.id || null });
        if (!post) {
            return res.status(404).json({ error: 'Collaboration post not found' });
        }

        return res.json({ data: post });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.patch('/collab-posts/:id', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const payload = parseCollabPostPayload(req.body, { partial: true });
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const hasPostFieldUpdates = Object.keys(payload.postFields).length > 0;
        const hasCollabFieldUpdates = Object.keys(payload.collabFields).length > 0;
        const hasSkillsUpdates = payload.skillsProvided;
        const hasTagsUpdates = payload.tagsProvided;

        if (!hasPostFieldUpdates && !hasCollabFieldUpdates && !hasSkillsUpdates && !hasTagsUpdates) {
            return res.status(400).json({ error: 'No supported fields provided for update' });
        }

        const meta = await getCollabPostMetaById(postId);
        if (!meta) {
            return res.status(404).json({ error: 'Collaboration post not found' });
        }

        if (!canEditCollabPost(meta, req.requestUser)) {
            return res.status(403).json({ error: 'Only the post owner can update this collaboration post.' });
        }

        if (Object.prototype.hasOwnProperty.call(payload.collabFields, 'openings')) {
            const memberCountByPostId = await getCollabMemberCountByPostIds([postId]);
            const memberCount = memberCountByPostId.get(postId) || 0;
            const requestedOpenings = Number(payload.collabFields.openings);
            if (requestedOpenings < memberCount) {
                return res.status(400).json({
                    error: `openings cannot be lower than current member count (${memberCount})`,
                });
            }
        }

        const nowIso = new Date().toISOString();

        if (hasPostFieldUpdates) {
            const postUpdatePayload = {
                ...payload.postFields,
                updated_at: nowIso,
            };

            const { data: updatedRows, error: postUpdateError } = await supabase
                .from(CONFIG.tables.posts)
                .update(postUpdatePayload)
                .eq('id', postId)
                .eq('type', 'collab')
                .select('id');

            if (postUpdateError) {
                throw postUpdateError;
            }

            if (!updatedRows || updatedRows.length === 0) {
                return res.status(404).json({ error: 'Collaboration post not found' });
            }
        }

        if (hasCollabFieldUpdates) {
            const collabUpdatePayload = {
                ...payload.collabFields,
                updated_at: nowIso,
            };

            const { data: updatedRows, error: collabUpdateError } = await supabase
                .from(CONFIG.tables.collabPosts)
                .update(collabUpdatePayload)
                .eq('post_id', postId)
                .select('post_id');

            if (collabUpdateError) {
                throw collabUpdateError;
            }

            if (!updatedRows || updatedRows.length === 0) {
                return res.status(404).json({ error: 'Collaboration post not found' });
            }
        }

        if (hasSkillsUpdates) {
            await replaceCollabSkills(postId, payload.requiredSkills);
        }

        if (hasTagsUpdates) {
            await replacePostTags(postId, payload.tagIds, payload.tagNames);
        }

        await closeCollabPostWhenFull(postId, { ...meta.collabRow, ...payload.collabFields });

        const post = await getCollabPostById(postId, { requestUserId: req.requestUser.id });
        return res.json({
            message: 'Collaboration post updated',
            data: post,
        });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.patch('/collab-posts/:id/status', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const statusResult = normalizeCollabStatus(req.body?.status, { fieldName: 'status' });
        if (statusResult.error) {
            return res.status(400).json({ error: statusResult.error });
        }

        const meta = await getCollabPostMetaById(postId);
        if (!meta) {
            return res.status(404).json({ error: 'Collaboration post not found' });
        }

        if (!canEditCollabPost(meta, req.requestUser)) {
            return res.status(403).json({ error: 'Only the post owner can change collaboration status.' });
        }

        const nowIso = new Date().toISOString();
        const { data: updatedRows, error: updateError } = await supabase
            .from(CONFIG.tables.collabPosts)
            .update({
                status: statusResult.value,
                updated_at: nowIso,
            })
            .eq('post_id', postId)
            .select('post_id');

        if (updateError) {
            throw updateError;
        }

        if (!updatedRows || updatedRows.length === 0) {
            return res.status(404).json({ error: 'Collaboration post not found' });
        }

        const post = await getCollabPostById(postId, { requestUserId: req.requestUser.id });
        return res.json({
            message: 'Collaboration status updated',
            data: post,
        });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/collab-posts/:id/join-requests', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const message = normalizeText(req.body?.message);
        if (!message) {
            return res.status(400).json({ error: 'message is required' });
        }
        if (message.length < 12) {
            return res.status(400).json({ error: 'message should be at least 12 characters' });
        }

        const meta = await getCollabPostMetaById(postId);
        if (!meta) {
            return res.status(404).json({ error: 'Collaboration post not found' });
        }

        if (normalizeText(meta.postRow.status).toLowerCase() === 'archived') {
            return res.status(400).json({ error: 'Archived collaboration posts cannot receive new requests.' });
        }

        const isOwner = String(meta.postRow.author_id || '') === String(req.requestUser.id || '');
        if (isOwner) {
            return res.status(400).json({ error: 'You cannot request to join your own collaboration post.' });
        }

        if (normalizeText(meta.collabRow.status).toLowerCase() !== 'open') {
            return res.status(400).json({ error: 'This collaboration post is currently closed.' });
        }

        const { data: existingMembership, error: membershipError } = await supabase
            .from(CONFIG.tables.collabMemberships)
            .select('id')
            .eq('post_id', postId)
            .eq('user_id', req.requestUser.id)
            .maybeSingle();

        if (membershipError) {
            throw membershipError;
        }

        if (existingMembership) {
            return res.status(400).json({ error: 'You are already a member of this collaboration.' });
        }

        const { data: existingRequest, error: existingRequestError } = await supabase
            .from(CONFIG.tables.collabJoinRequests)
            .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
            .eq('post_id', postId)
            .eq('user_id', req.requestUser.id)
            .maybeSingle();

        if (existingRequestError) {
            throw existingRequestError;
        }

        const nowIso = new Date().toISOString();
        let savedRequest = null;
        let responseStatus = 201;

        if (existingRequest) {
            const currentStatus = normalizeText(existingRequest.status).toLowerCase();
            if (currentStatus === 'pending') {
                return res.status(409).json({ error: 'You already have a pending request for this post.' });
            }
            if (currentStatus === 'accepted') {
                return res.status(409).json({ error: 'Your request has already been accepted for this post.' });
            }

            const { data: updatedRequest, error: updateError } = await supabase
                .from(CONFIG.tables.collabJoinRequests)
                .update({
                    message,
                    status: 'pending',
                    created_at: nowIso,
                    updated_at: nowIso,
                    reviewed_at: null,
                })
                .eq('id', existingRequest.id)
                .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
                .single();

            if (updateError) {
                throw updateError;
            }

            savedRequest = updatedRequest;
            responseStatus = 200;
        } else {
            const { data: createdRequest, error: createError } = await supabase
                .from(CONFIG.tables.collabJoinRequests)
                .insert({
                    post_id: postId,
                    user_id: req.requestUser.id,
                    message,
                    status: 'pending',
                    updated_at: nowIso,
                    reviewed_at: null,
                })
                .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
                .single();

            if (createError) {
                throw createError;
            }

            savedRequest = createdRequest;
        }

        const userMap = await getUsersByIds([savedRequest.user_id]);
        const post = await getCollabPostById(postId, { requestUserId: req.requestUser.id });

        return res.status(responseStatus).json({
            message: 'Join request submitted',
            data: mapCollabJoinRequest(savedRequest, userMap),
            meta: {
                pendingRequestCount: post?.pendingRequestCount || 0,
                joinRequestCount: post?.joinRequestCount || 0,
                memberCount: post?.memberCount || 0,
                collabStatus: post?.status || 'OPEN',
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/collab-posts/:id/join-requests', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const statusRaw = normalizeText(req.query.status).toLowerCase();
        const requestedStatus = statusRaw || 'pending';
        if (requestedStatus !== 'all') {
            const statusValidation = normalizeJoinRequestStatus(requestedStatus, { fieldName: 'status' });
            if (statusValidation.error) {
                return res.status(400).json({ error: statusValidation.error });
            }
        }

        const meta = await getCollabPostMetaById(postId);
        if (!meta) {
            return res.status(404).json({ error: 'Collaboration post not found' });
        }

        if (!canEditCollabPost(meta, req.requestUser)) {
            return res.status(403).json({ error: 'Only the post owner can view join requests.' });
        }

        const requests = await getCollabJoinRequests(postId, { status: requestedStatus });
        return res.json({
            data: requests,
            meta: {
                postId,
                total: requests.length,
                status: requestedStatus,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.patch('/join-requests/:id', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const requestId = normalizeText(req.params.id);
        if (!requestId) {
            return res.status(400).json({ error: 'join request id is required' });
        }

        const statusResult = normalizeJoinRequestStatus(req.body?.status, { fieldName: 'status' });
        if (statusResult.error) {
            return res.status(400).json({ error: statusResult.error });
        }

        const { data: targetRequest, error: targetRequestError } = await supabase
            .from(CONFIG.tables.collabJoinRequests)
            .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
            .eq('id', requestId)
            .maybeSingle();

        if (targetRequestError) {
            throw targetRequestError;
        }

        if (!targetRequest) {
            return res.status(404).json({ error: 'Join request not found' });
        }

        const meta = await getCollabPostMetaById(targetRequest.post_id);
        if (!meta) {
            return res.status(404).json({ error: 'Collaboration post not found' });
        }

        if (!canEditCollabPost(meta, req.requestUser)) {
            return res.status(403).json({ error: 'Only the post owner can review join requests.' });
        }

        const currentRequestStatus = normalizeText(targetRequest.status).toLowerCase();
        if (currentRequestStatus === 'accepted' && statusResult.value === 'rejected') {
            return res.status(400).json({
                error: 'Accepted requests cannot be rejected. Remove membership manually if needed.',
            });
        }

        const nowIso = new Date().toISOString();

        if (statusResult.value === 'accepted') {
            const { data: existingMembership, error: membershipLookupError } = await supabase
                .from(CONFIG.tables.collabMemberships)
                .select('id')
                .eq('post_id', targetRequest.post_id)
                .eq('user_id', targetRequest.user_id)
                .maybeSingle();

            if (membershipLookupError) {
                throw membershipLookupError;
            }

            if (!existingMembership) {
                const memberCountByPostId = await getCollabMemberCountByPostIds([targetRequest.post_id]);
                const memberCount = memberCountByPostId.get(targetRequest.post_id) || 0;
                const openings = Number.isFinite(Number(meta.collabRow.openings))
                    ? Math.max(1, Math.trunc(Number(meta.collabRow.openings)))
                    : 1;

                if (memberCount >= openings) {
                    return res.status(400).json({ error: 'No openings left for this collaboration post.' });
                }

                const teamRoleRaw = req.body?.teamRole !== undefined
                    ? req.body.teamRole
                    : req.body?.team_role;
                const teamRole = normalizeText(teamRoleRaw) || null;

                const { error: membershipInsertError } = await supabase
                    .from(CONFIG.tables.collabMemberships)
                    .insert({
                        post_id: targetRequest.post_id,
                        user_id: targetRequest.user_id,
                        team_role: teamRole,
                    });

                if (membershipInsertError) {
                    throw membershipInsertError;
                }
            }
        }

        const { data: updatedRequest, error: requestUpdateError } = await supabase
            .from(CONFIG.tables.collabJoinRequests)
            .update({
                status: statusResult.value,
                updated_at: nowIso,
                reviewed_at: nowIso,
            })
            .eq('id', requestId)
            .select('id, post_id, user_id, message, status, created_at, updated_at, reviewed_at')
            .single();

        if (requestUpdateError) {
            throw requestUpdateError;
        }

        if (statusResult.value === 'accepted') {
            await closeCollabPostWhenFull(targetRequest.post_id, meta.collabRow);
        }

        const userMap = await getUsersByIds([updatedRequest.user_id]);
        const post = await getCollabPostById(targetRequest.post_id, { requestUserId: req.requestUser.id });

        return res.json({
            message: 'Join request updated',
            data: mapCollabJoinRequest(updatedRequest, userMap),
            meta: {
                postId: targetRequest.post_id,
                pendingRequestCount: post?.pendingRequestCount || 0,
                joinRequestCount: post?.joinRequestCount || 0,
                memberCount: post?.memberCount || 0,
                collabStatus: post?.status || 'OPEN',
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/collab-posts/:id/members', ensureDb, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const meta = await getCollabPostMetaById(postId);
        if (!meta) {
            return res.status(404).json({ error: 'Collaboration post not found' });
        }

        const members = await getCollabMembers(postId);
        return res.json({
            data: members,
            meta: {
                postId,
                total: members.length,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/collab-notifications', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const limit = parseIntInRange(
            req.query.limit,
            COLLAB_NOTIFICATION_DEFAULT_LIMIT,
            1,
            COLLAB_NOTIFICATION_MAX_LIMIT
        );

        const notifications = await getCollabNotificationsForUser(req.requestUser.id, { limit });
        return res.json({
            data: notifications,
            meta: {
                limit,
                total: notifications.length,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/event-notifications', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const limit = parseIntInRange(
            req.query.limit,
            EVENT_NOTIFICATION_DEFAULT_LIMIT,
            1,
            EVENT_NOTIFICATION_MAX_LIMIT
        );

        const notifications = await getEventVolunteerNotificationsForUser(req.requestUser.id, { limit });
        return res.json({
            data: notifications,
            meta: {
                limit,
                total: notifications.length,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/newsletter/settings', ensureDb, ensureAuthenticated, ensureModerator, async (req, res) => {
    try {
        const scheduleState = await getNewsletterScheduleState();
        return res.json({
            data: scheduleState,
        });
    } catch (error) {
        if (isMissingTableError(error)) return newsletterSchemaError(res);
        return res.status(error?.status || 500).json({
            error: error?.message || formatSupabaseError(error),
            ...(Array.isArray(error?.requiredEnv) ? { requiredEnv: error.requiredEnv } : {}),
        });
    }
});

app.patch('/newsletter/settings', ensureDb, ensureAuthenticated, ensureModerator, async (req, res) => {
    try {
        const autoSendEnabledInput = req.body?.autoSendEnabled ?? req.body?.auto_send_enabled;
        if (typeof autoSendEnabledInput !== 'boolean') {
            return res.status(400).json({ error: 'autoSendEnabled must be true or false.' });
        }

        const updatedSettings = await updateNewsletterSettings({
            autoSendEnabled: autoSendEnabledInput,
            updatedBy: req.requestUser.id,
        });

        return res.json({
            message: `Newsletter auto-send ${autoSendEnabledInput ? 'enabled' : 'disabled'}.`,
            data: buildNewsletterScheduleState(updatedSettings),
        });
    } catch (error) {
        if (isMissingTableError(error)) return newsletterSchemaError(res);
        return res.status(error?.status || 500).json({
            error: error?.message || formatSupabaseError(error),
            ...(Array.isArray(error?.requiredEnv) ? { requiredEnv: error.requiredEnv } : {}),
        });
    }
});

app.get('/newsletter/recipients', ensureDb, ensureAuthenticated, ensureModerator, async (req, res) => {
    try {
        const recipientSet = await getNewsletterRecipients();
        return res.json({
            data: recipientSet.validRecipients,
            summary: {
                totalUsers: recipientSet.totalUsers,
                validEmails: recipientSet.validEmails,
                skippedInvalidEmails: recipientSet.skippedInvalidEmails,
                skippedDuplicateEmails: recipientSet.skippedDuplicateEmails,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return newsletterSchemaError(res);
        return res.status(error?.status || 500).json({
            error: error?.message || formatSupabaseError(error),
            ...(Array.isArray(error?.requiredEnv) ? { requiredEnv: error.requiredEnv } : {}),
        });
    }
});

app.get('/newsletter/current', ensureDb, ensureAuthenticated, ensureModerator, async (req, res) => {
    try {
        const issueContext = getNewsletterIssueContext(new Date());
        const existingIssue = await getNewsletterIssueByMonth(issueContext.issueMonth, { includeLatestRun: true });
        const contentSummary = await buildMonthlyNewsletterContentSummary(issueContext, existingIssue);
        const scheduleState = await getNewsletterScheduleState();

        return res.json({
            data: {
                draft: {
                    subject: buildNewsletterSubject(contentSummary.issueMonthLabel),
                    ...contentSummary,
                },
                issue: existingIssue
                    ? mapNewsletterIssueRow(existingIssue, existingIssue.latestRun || null)
                    : null,
                settings: scheduleState,
                meta: {
                    timeZone: CONFIG.newsletter.timeZone,
                    smtpConfigured: isNewsletterEmailConfigured(),
                    scheduleEnabled: CONFIG.newsletter.scheduleEnabled,
                    autoSendEnabled: scheduleState.autoSendEnabled,
                    effectiveAutoSendEnabled: scheduleState.effectiveAutoSendEnabled,
                    automaticDueToday: issueContext.day === 1,
                    automaticAlreadySent: Boolean(existingIssue?.automatic_sent_at),
                },
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return newsletterSchemaError(res);
        return res.status(error?.status || 500).json({
            error: error?.message || formatSupabaseError(error),
            ...(Array.isArray(error?.requiredEnv) ? { requiredEnv: error.requiredEnv } : {}),
        });
    }
});

app.post('/newsletter/send', ensureDb, ensureAuthenticated, ensureModerator, async (req, res) => {
    try {
        if (!isNewsletterEmailConfigured()) {
            return newsletterEmailUnavailable(res);
        }

        const issueContext = getNewsletterIssueContext(new Date());
        const existingIssue = await getNewsletterIssueByMonth(issueContext.issueMonth);
        if (isNewsletterIssueActivelySending(existingIssue)) {
            return res.status(409).json({
                error: 'A newsletter send is already in progress for this month. Refresh and try again shortly.',
            });
        }

        const result = await sendCurrentMonthNewsletter({
            triggerType: 'manual',
            initiatedBy: req.requestUser.id,
            recipientIds: Array.isArray(req.body?.recipientIds) ? req.body.recipientIds : null,
        });

        return res.json({
            message: 'Newsletter send completed.',
            data: result,
        });
    } catch (error) {
        if (isMissingTableError(error)) return newsletterSchemaError(res);
        return res.status(error?.status || 500).json({
            error: error?.message || formatSupabaseError(error),
            ...(Array.isArray(error?.requiredEnv) ? { requiredEnv: error.requiredEnv } : {}),
        });
    }
});

app.get('/newsletter/notifications', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const limit = parseIntInRange(
            req.query.limit,
            NEWSLETTER_NOTIFICATION_DEFAULT_LIMIT,
            1,
            NEWSLETTER_NOTIFICATION_MAX_LIMIT
        );

        const notifications = await getNewsletterNotifications({ limit });
        return res.json({
            data: notifications,
            meta: {
                limit,
                total: notifications.length,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return newsletterSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/posts/:id', ensureDb, async (req, res) => {
    try {
        const requestUser = getRequestUser(req);
        const includeComments = parseBool(req.query.includeComments, false);
        const commentsLimit = parseIntInRange(req.query.commentsLimit, 50, 1, 200);
        const commentsOffset = parseIntInRange(req.query.commentsOffset, 0, 0, Number.MAX_SAFE_INTEGER);

        const post = await getPostById(req.params.id, { requestUserId: requestUser?.id || null });
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (includeComments) {
            const comments = await getCommentsForPost(req.params.id, {
                limit: commentsLimit,
                offset: commentsOffset,
            });
            return res.json({ data: { ...post, comments: comments.data }, commentPagination: comments.pagination });
        }

        return res.json({ data: post });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/posts', ensureDb, async (req, res) => {
    let createdPostId = null;
    let createAsCollab = false;
    let createAsEvent = false;

    try {
        const payload = buildPostPayload(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const normalizedType = String(payload.postFields.type || '').toUpperCase();
        createAsCollab = isCollabType(normalizedType);
        createAsEvent = isEventType(normalizedType);

        if (createAsEvent) {
            if (!normalizeText(payload.postFields.title)) {
                payload.postFields.title = getDefaultEventTitle(normalizedType);
            }

            if (!normalizeText(payload.postFields.summary)) {
                payload.postFields.summary = getDefaultEventSummary(normalizedType);
            }
        }

        if (createAsCollab) {
            const requestUser = getRequestUser(req);
            if (!requestUser?.id) {
                return res.status(401).json({
                    error: 'Authentication is required to create COLLAB posts.',
                });
            }
            payload.postFields.type = 'collab';
            payload.postFields.author_id = requestUser.id;
        }

        if (normalizedType === 'ANNOUNCEMENT' || normalizedType === 'JOB') {
            const requestUser = getRequestUser(req);
            if (!requestUser?.id) {
                return res.status(401).json({
                    error: `Authentication is required to create ${normalizedType} posts.`,
                });
            }

            payload.postFields.author_id = requestUser.id;

            if (normalizedType === 'ANNOUNCEMENT' && !canCreateAnnouncement(requestUser.role)) {
                return res.status(403).json({
                    error: 'Only faculty/admin can create ANNOUNCEMENT posts.',
                });
            }
        }

        if (normalizedType === 'JOB') {
            const requestUser = getRequestUser(req);
            if (canCreateJobAsBypassRole(requestUser?.role)) {
                payload.postFields.author_id = requestUser.id;
            } else {
                if (!isAlumniRole(requestUser?.role)) {
                    return res.status(403).json({
                        error: 'Only verified alumni or faculty/admin can create JOB posts.',
                    });
                }

                const verificationStatus = await getAlumniVerificationStatus(requestUser.id).catch((error) => {
                    if (error?.code === '42P01') {
                        const err = new Error(`Missing table "${CONFIG.tables.alumniVerificationApplications}". Run services/user-service/schema.sql first.`);
                        err.status = 500;
                        throw err;
                    }
                    throw error;
                });

                if (verificationStatus !== 'approved') {
                    return res.status(403).json({
                        error: 'Only verified alumni or faculty/admin can create JOB posts.',
                    });
                }

                payload.postFields.author_id = requestUser.id;
            }
        }

        const { data: createdPost, error: createError } = await supabase
            .from(CONFIG.tables.posts)
            .insert(payload.postFields)
            .select('*')
            .single();

        if (createError) {
            throw createError;
        }

        createdPostId = createdPost.id;

        if (payload.tagsProvided) {
            await replacePostTags(createdPost.id, payload.tagIds, payload.tagNames);
        }

        if (payload.refProvided) {
            await replacePostRef(createdPost.id, payload.ref);
        }

        if (createAsEvent) {
            await ensureDefaultEventRefForPost(createdPost, payload.refProvided ? payload.ref : null);
        }

        if (createAsCollab) {
            await ensureDefaultCollabDataForPost(createdPost);
        }

        const fullPost = createAsCollab
            ? await getCollabPostById(createdPost.id, { requestUserId: payload.postFields.author_id || null })
            : await getPostById(createdPost.id);

        return res.status(201).json({
            message: 'Post created',
            data: fullPost || mapPost(createdPost),
        });
    } catch (error) {
        if (createAsCollab && createdPostId) {
            await supabase
                .from(CONFIG.tables.posts)
                .delete()
                .eq('id', createdPostId)
                .catch(() => null);
        }
        if (isMissingTableError(error)) return collabSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.patch('/posts/:id', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const payload = buildPostPayload(req.body, { partial: true });
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const hasPostFields = Object.keys(payload.postFields).length > 0;
        const hasTagChanges = payload.tagsProvided;
        const hasRefChanges = payload.refProvided;
        const hasAuthorUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'author_id');
        const hasPinnedUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'pinned');
        const hasTypeUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'type');
        if (hasTypeUpdate && isCollabType(payload.postFields.type)) {
            return res.status(400).json({
                error: 'Use PATCH /collab-posts/:id to manage collaboration posts.',
            });
        }

        if (hasAuthorUpdate) {
            return res.status(400).json({
                error: 'authorId cannot be updated for an existing post.',
            });
        }

        const isExpiryUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'expires_at');
        const isStatusUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'status');
        const normalizedNextStatus = isStatusUpdate
            ? String(payload.postFields.status || '').trim().toLowerCase()
            : '';
        const isArchiveUpdate = isStatusUpdate && normalizedNextStatus === 'archived';
        const isOwner = String(postMeta.author_id || '') === String(req.requestUser.id || '');
        const isModerator = isModeratorRole(req.requestUser.role);
        const hasOwnerContentFieldUpdates = Object.keys(payload.postFields).some((field) => {
            if (field === 'pinned') return false;
            if (field === 'status' && isArchiveUpdate) return false;
            return true;
        });
        const hasOwnerContentChanges = hasOwnerContentFieldUpdates || hasTagChanges || hasRefChanges;

        if (!hasPostFields && !hasTagChanges && !hasRefChanges) {
            return res.status(400).json({
                error: 'No supported fields provided for update',
            });
        }

        if (hasPinnedUpdate && !isModerator) {
            return res.status(403).json({
                error: 'Only faculty/admin can pin posts.',
            });
        }

        if (hasOwnerContentChanges && !isOwner) {
            return res.status(403).json({
                error: 'Only the original author can edit this post.',
            });
        }

        if (isArchiveUpdate) {
            if (!isModerator && !isOwner) {
                return res.status(403).json({ error: 'Only faculty/admin or the original author can archive posts.' });
            }
        }

        if (isExpiryUpdate && !isOwner) {
            return res.status(403).json({
                error: 'Only the original author can update expiry.',
            });
        }

        const nowIso = new Date().toISOString();

        if (hasPostFields) {
            const { data: updatedRows, error: updateError } = await supabase
                .from(CONFIG.tables.posts)
                .update({
                    ...payload.postFields,
                    updated_at: nowIso,
                })
                .eq('id', postId)
                .select('id');

            if (updateError) {
                throw updateError;
            }

            if (!updatedRows || updatedRows.length === 0) {
                return res.status(404).json({ error: 'Post not found' });
            }
        } else {
            const { data: touchedRows, error: touchError } = await supabase
                .from(CONFIG.tables.posts)
                .update({ updated_at: nowIso })
                .eq('id', postId)
                .select('id');

            if (touchError) {
                throw touchError;
            }

            if (!touchedRows || touchedRows.length === 0) {
                return res.status(404).json({ error: 'Post not found' });
            }
        }

        if (hasTagChanges) {
            await replacePostTags(postId, payload.tagIds, payload.tagNames);
        }

        if (hasRefChanges) {
            await replacePostRef(postId, payload.ref);
        }

        const fullPost = await getPostById(postId, { requestUserId: req.requestUser.id });
        return res.json({
            message: 'Post updated',
            data: fullPost,
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.delete('/posts/:id', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const isOwner = String(postMeta.author_id || '') === String(req.requestUser.id || '');
        if (!isOwner && !isModeratorRole(req.requestUser.role)) {
            return res.status(403).json({ error: 'Only faculty/admin or the original author can delete this post.' });
        }

        const { data: deletedRows, error: deleteError } = await supabase
            .from(CONFIG.tables.posts)
            .delete()
            .eq('id', postId)
            .select('id');

        if (deleteError) {
            throw deleteError;
        }

        if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }

        return res.json({
            message: 'Post deleted',
            data: { id: postId },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/posts/:id/vote', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const voteInput = parseVoteInput(req.body?.vote ?? req.body?.direction ?? req.body?.value);
        if (voteInput.error) {
            return res.status(400).json({ error: voteInput.error });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (String(postMeta.status || '').toLowerCase() === 'archived') {
            return res.status(400).json({ error: 'Archived posts cannot be voted on.' });
        }

        if (voteInput.value === 0) {
            const { error: deleteError } = await supabase
                .from(CONFIG.tables.postVotes)
                .delete()
                .eq('post_id', postId)
                .eq('user_id', req.requestUser.id);

            if (deleteError) {
                if (isMissingTableError(deleteError)) return socialSchemaError(res);
                throw deleteError;
            }
        } else {
            const nowIso = new Date().toISOString();
            const { error: upsertError } = await supabase
                .from(CONFIG.tables.postVotes)
                .upsert({
                    post_id: postId,
                    user_id: req.requestUser.id,
                    vote: voteInput.value,
                    updated_at: nowIso,
                }, {
                    onConflict: 'post_id,user_id',
                });

            if (upsertError) {
                if (isMissingTableError(upsertError)) return socialSchemaError(res);
                throw upsertError;
            }
        }

        const post = await getPostById(postId, { requestUserId: req.requestUser.id });
        return res.json({
            message: voteInput.value === 0 ? 'Vote removed' : 'Vote updated',
            data: {
                postId,
                userVote: post?.userVote || null,
                score: post?.score || 0,
                voteScore: post?.voteScore || 0,
                upvoteCount: post?.upvoteCount || 0,
                downvoteCount: post?.downvoteCount || 0,
                commentCount: post?.commentCount || 0,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/posts/:id/volunteers', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (String(postMeta.type || '').toUpperCase() !== 'EVENT') {
            return res.status(400).json({ error: 'Volunteer roster is only available for EVENT posts.' });
        }

        const isOwner = String(postMeta.author_id || '') === String(req.requestUser.id || '');
        if (!isOwner) {
            return res.status(403).json({ error: 'Only the original event poster can view volunteer enrollments.' });
        }

        const enrollments = await getEventVolunteerEnrollments(postId);
        return res.json({
            data: enrollments,
            meta: {
                postId,
                total: enrollments.length,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/posts/:id/volunteers', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const payload = parseVolunteerEnrollmentInput(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (String(postMeta.type || '').toUpperCase() !== 'EVENT') {
            return res.status(400).json({ error: 'Volunteer enrollment is only available for EVENT posts.' });
        }

        if (String(postMeta.status || '').toLowerCase() === 'archived') {
            return res.status(400).json({ error: 'Archived event posts cannot accept volunteers.' });
        }

        const isOwner = String(postMeta.author_id || '') === String(req.requestUser.id || '');
        if (isOwner) {
            return res.status(400).json({ error: 'Event creators cannot enroll themselves as volunteers.' });
        }

        const existingEnrollment = await getEventVolunteerEnrollmentByPostAndUser(postId, req.requestUser.id);
        if (existingEnrollment) {
            return res.status(409).json({ error: 'You have already enrolled as a volunteer for this event.' });
        }

        const nowIso = new Date().toISOString();
        const { data: createdEnrollment, error: insertError } = await supabase
            .from(CONFIG.tables.eventVolunteerEnrollments)
            .insert({
                post_id: postId,
                user_id: req.requestUser.id,
                full_name: payload.fullName,
                contact_info: payload.contactInfo,
                reason: payload.reason,
                availability: payload.availability,
                notes: payload.notes,
                updated_at: nowIso,
            })
            .select('*')
            .single();

        if (insertError) {
            if (insertError.code === '23505') {
                return res.status(409).json({ error: 'You have already enrolled as a volunteer for this event.' });
            }
            if (isMissingTableError(insertError)) return socialSchemaError(res);
            throw insertError;
        }

        const userMap = await getUsersByIds([req.requestUser.id]);
        const post = await getPostById(postId, { requestUserId: req.requestUser.id });

        return res.status(201).json({
            message: 'Volunteer enrollment submitted',
            data: mapEventVolunteerEnrollment(createdEnrollment, userMap.get(req.requestUser.id) || null),
            meta: {
                postId,
                volunteerCount: post?.volunteerCount || 0,
                viewerHasVolunteerEnrollment: Boolean(post?.viewerHasVolunteerEnrollment),
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/posts/:id/comments', ensureDb, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        const limit = parseIntInRange(req.query.limit, 50, 1, 200);
        const offset = parseIntInRange(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const comments = await getCommentsForPost(postId, { limit, offset });
        return res.json(comments);
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/posts/:id/comments', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        if (!postId) {
            return res.status(400).json({ error: 'post id is required' });
        }

        const payload = parseCommentInput(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const postMeta = await getPostMetaById(postId);
        if (!postMeta) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (String(postMeta.status || '').toLowerCase() === 'archived') {
            return res.status(400).json({ error: 'Archived posts cannot be commented on.' });
        }

        const nowIso = new Date().toISOString();
        const { data: createdComment, error: insertError } = await supabase
            .from(CONFIG.tables.postComments)
            .insert({
                post_id: postId,
                author_id: req.requestUser.id,
                content: payload.content,
                updated_at: nowIso,
            })
            .select('*')
            .single();

        if (insertError) {
            if (isMissingTableError(insertError)) return socialSchemaError(res);
            throw insertError;
        }

        const userMap = await getUsersByIds([req.requestUser.id]);
        const post = await getPostById(postId, { requestUserId: req.requestUser.id });
        return res.status(201).json({
            message: 'Comment posted',
            data: mapComment(createdComment, userMap.get(req.requestUser.id) || null),
            meta: {
                commentCount: post?.commentCount || 0,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.patch('/posts/:id/comments/:commentId', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        const commentId = normalizeText(req.params.commentId);
        if (!postId || !commentId) {
            return res.status(400).json({ error: 'post id and comment id are required' });
        }

        const payload = parseCommentInput(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const existingComment = await getPostCommentById(postId, commentId);
        if (!existingComment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isOwner = String(existingComment.author_id) === String(req.requestUser.id);
        if (!isOwner && !isModeratorRole(req.requestUser.role)) {
            return res.status(403).json({ error: 'You can only edit your own comment.' });
        }

        const nowIso = new Date().toISOString();
        const { data: updatedComment, error: updateError } = await supabase
            .from(CONFIG.tables.postComments)
            .update({
                content: payload.content,
                updated_at: nowIso,
            })
            .eq('id', commentId)
            .eq('post_id', postId)
            .select('*')
            .single();

        if (updateError) {
            if (isMissingTableError(updateError)) return socialSchemaError(res);
            throw updateError;
        }

        const userMap = await getUsersByIds([updatedComment.author_id]);
        return res.json({
            message: 'Comment updated',
            data: mapComment(updatedComment, userMap.get(updatedComment.author_id) || null),
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.delete('/posts/:id/comments/:commentId', ensureDb, ensureAuthenticated, async (req, res) => {
    try {
        const postId = normalizeText(req.params.id);
        const commentId = normalizeText(req.params.commentId);
        if (!postId || !commentId) {
            return res.status(400).json({ error: 'post id and comment id are required' });
        }

        const existingComment = await getPostCommentById(postId, commentId);
        if (!existingComment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const isOwner = String(existingComment.author_id) === String(req.requestUser.id);
        if (!isOwner && !isModeratorRole(req.requestUser.role)) {
            return res.status(403).json({ error: 'You can only delete your own comment.' });
        }

        const { error: deleteError } = await supabase
            .from(CONFIG.tables.postComments)
            .delete()
            .eq('id', commentId)
            .eq('post_id', postId);

        if (deleteError) {
            if (isMissingTableError(deleteError)) return socialSchemaError(res);
            throw deleteError;
        }

        const post = await getPostById(postId, { requestUserId: req.requestUser.id });
        return res.json({
            message: 'Comment deleted',
            data: {
                id: commentId,
                postId,
            },
            meta: {
                commentCount: post?.commentCount || 0,
            },
        });
    } catch (error) {
        if (isMissingTableError(error)) return socialSchemaError(res);
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.get('/tags', ensureDb, async (req, res) => {
    try {
        const limit = parseIntInRange(req.query.limit, 100, 1, 500);
        const q = sanitizeSearchTerm(req.query.q || '');

        let query = supabase
            .from(CONFIG.tables.tags)
            .select('id, name, slug, created_at')
            .order('name', { ascending: true })
            .limit(limit);

        if (q) {
            query = query.or(`name.ilike.%${q}%,slug.ilike.%${q}%`);
        }

        const { data, error } = await query;
        if (error) {
            throw error;
        }

        return res.json({
            data: (data || []).map(mapTag),
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.post('/tags', ensureDb, async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const slugInput = typeof req.body.slug === 'string' ? req.body.slug.trim() : '';

        if (!name) {
            return res.status(400).json({ error: 'name is required' });
        }

        const slug = slugInput || slugify(name);
        if (!slug) {
            return res.status(400).json({ error: 'Could not generate a valid slug' });
        }

        const { data, error } = await supabase
            .from(CONFIG.tables.tags)
            .upsert({ name, slug }, { onConflict: 'slug' })
            .select('id, name, slug, created_at')
            .single();

        if (error) {
            throw error;
        }

        return res.status(201).json({
            message: 'Tag created',
            data: mapTag(data),
        });
    } catch (error) {
        return res.status(500).json({ error: formatSupabaseError(error) });
    }
});

app.use((req, res) => {
    return res.status(404).json({ error: 'Route not found' });
});

const server = app.listen(PORT, () => {
    console.log(`Post Service is running on port ${PORT}`);
    if (!isSupabaseConfigured()) {
        console.log('Post Service started without Supabase config. DB routes will return 503.');
    }
    if (!isSearchDbConfigured()) {
        console.log('Post Service started without SUPABASE_DB_URL. Search route will return 503.');
    }
});

server.on('close', () => {
    closeSearchDbPool().catch((error) => {
        console.error('Post search pool shutdown failed:', error.message);
    });
});

let archiveTimer = null;
if (CONFIG.archiveIntervalMs > 0 && isSupabaseConfigured()) {
    archiveTimer = setInterval(async () => {
        try {
            const result = await archiveExpiredPosts();
            if (result.archivedCount > 0) {
                console.log(`Archived ${result.archivedCount} expired posts`);
            }
        } catch (error) {
            console.error('Post archive sweep failed:', formatSupabaseError(error));
        }
    }, CONFIG.archiveIntervalMs);

    if (typeof archiveTimer.unref === 'function') {
        archiveTimer.unref();
    }
}

let newsletterTimer = null;
if (CONFIG.newsletter.scheduleEnabled && isSupabaseConfigured()) {
    const runNewsletterSchedule = async () => {
        try {
            const result = await maybeRunAutomaticMonthlyNewsletter();
            if (!result?.skipped) {
                console.log(`Automatic newsletter completed for ${result?.issue?.issueMonth || 'current month'}.`);
            }
        } catch (error) {
            console.error('Automatic newsletter run failed:', error?.message || formatSupabaseError(error));
        }
    };

    runNewsletterSchedule().catch((error) => {
        console.error('Initial newsletter schedule check failed:', error?.message || formatSupabaseError(error));
    });

    newsletterTimer = setInterval(runNewsletterSchedule, CONFIG.newsletter.scheduleIntervalMs);
    if (typeof newsletterTimer.unref === 'function') {
        newsletterTimer.unref();
    }
}

module.exports = { app, server, supabase, CONFIG };
