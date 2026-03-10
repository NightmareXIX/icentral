const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { query: searchQuery, isDbConfigured: isSearchDbConfigured, closePool: closeSearchDbPool } = require('./db');

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
const COLLAB_MODES = new Set(['remote', 'onsite', 'hybrid']);
const COLLAB_STATUSES = new Set(['open', 'closed']);
const COLLAB_JOIN_REQUEST_STATUSES = new Set(['pending', 'accepted', 'rejected']);
const COLLAB_FALLBACK_CATEGORY = 'Other Academic Collaboration';
const COLLAB_FALLBACK_DURATION = 'Not specified';
const COLLAB_FALLBACK_SKILL = 'General collaboration';

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
        collabPosts: process.env.COLLAB_POSTS_TABLE || 'collab_posts',
        collabSkills: process.env.COLLAB_SKILLS_TABLE || 'collab_skills',
        collabJoinRequests: process.env.COLLAB_JOIN_REQUESTS_TABLE || 'collab_join_requests',
        collabMemberships: process.env.COLLAB_MEMBERSHIPS_TABLE || 'collab_memberships',
        alumniVerificationApplications: process.env.ALUMNI_VERIFICATION_TABLE || 'alumni_verification_applications',
    },
    feedDefaultLimit: Number(process.env.POST_FEED_DEFAULT_LIMIT) || 20,
    feedMaxLimit: Number(process.env.POST_FEED_MAX_LIMIT) || 100,
    archiveIntervalMs: Number(process.env.POST_ARCHIVE_INTERVAL_MS) || 0,
    jwtSecret: process.env.JWT_SECRET || 'HelloWorldKey',
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
    };
})();

const supabase = (CONFIG.supabaseUrl && CONFIG.supabaseKey)
    ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
        auth: { persistSession: false },
        db: { schema: CONFIG.schema },
    })
    : null;

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

function isCollabType(value) {
    return String(value || '').trim().toUpperCase() === 'COLLAB';
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

    if (!partial) {
        if (!postFields.type || typeof postFields.type !== 'string') {
            errors.push('type is required');
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

    return withTags.map((post) => {
        const voteSummary = voteSummaryByPostId.get(post.id) || {
            score: 0,
            voteScore: 0,
            upvoteCount: 0,
            downvoteCount: 0,
            userVote: null,
        };
        const commentCount = commentCountByPostId.get(post.id) || 0;
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
        .select('id, status, author_id')
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

    return withTags.map((post) => {
        const collab = collabByPostId.get(String(post.id));
        const author = post.authorId ? (authorMap.get(post.authorId) || null) : null;
        const tags = tagsByPostId.get(String(post.id)) || [];
        const skills = skillsByPostId.get(String(post.id)) || [];
        const memberCount = memberCountByPostId.get(String(post.id)) || 0;
        const totalRequestCount = requestSummary.totalCountByPostId.get(String(post.id)) || 0;
        const pendingRequestCount = requestSummary.pendingCountByPostId.get(String(post.id)) || 0;
        const currentUserRequest = requestSummary.currentUserRequestByPostId.get(String(post.id)) || null;

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
            'GET /posts/:id',
            'POST /posts',
            'PATCH /posts/:id',
            'DELETE /posts/:id',
            'POST /posts/:id/vote',
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

    try {
        const payload = buildPostPayload(req.body);
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const normalizedType = String(payload.postFields.type || '').toUpperCase();
        createAsCollab = isCollabType(normalizedType);

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

app.patch('/posts/:id', ensureDb, async (req, res) => {
    try {
        const payload = buildPostPayload(req.body, { partial: true });
        if (payload.errors.length) {
            return res.status(400).json({ error: 'Validation failed', details: payload.errors });
        }

        const hasPostFields = Object.keys(payload.postFields).length > 0;
        const hasTagChanges = payload.tagsProvided;
        const hasRefChanges = payload.refProvided;
        const hasTypeUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'type');
        if (hasTypeUpdate && isCollabType(payload.postFields.type)) {
            return res.status(400).json({
                error: 'Use PATCH /collab-posts/:id to manage collaboration posts.',
            });
        }

        const isExpiryUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'expires_at');
        const isStatusUpdate = Object.prototype.hasOwnProperty.call(payload.postFields, 'status');
        const normalizedNextStatus = isStatusUpdate
            ? String(payload.postFields.status || '').trim().toLowerCase()
            : '';
        const isArchiveUpdate = isStatusUpdate && normalizedNextStatus === 'archived';

        if (!hasPostFields && !hasTagChanges && !hasRefChanges) {
            return res.status(400).json({
                error: 'No supported fields provided for update',
            });
        }

        if (isArchiveUpdate) {
            const requestUser = getRequestUser(req);
            if (!requestUser?.id) {
                return res.status(401).json({ error: 'Authentication is required to archive posts.' });
            }
            if (!isModeratorRole(requestUser.role)) {
                const authorId = await getPostAuthorId(req.params.id);
                if (authorId === null) {
                    return res.status(404).json({ error: 'Post not found' });
                }

                if (!authorId || String(authorId) !== String(requestUser.id)) {
                    return res.status(403).json({ error: 'Only faculty/admin or the original author can archive posts.' });
                }
            }
        }

        if (isExpiryUpdate) {
            const requestUser = getRequestUser(req);
            if (!requestUser?.id) {
                return res.status(401).json({ error: 'Authentication is required to update expiry.' });
            }

            if (!isModeratorRole(requestUser.role)) {
                const authorId = await getPostAuthorId(req.params.id);
                if (authorId === null) {
                    return res.status(404).json({ error: 'Post not found' });
                }

                if (!authorId || String(authorId) !== String(requestUser.id)) {
                    return res.status(403).json({
                        error: 'Only moderators and the original author can update expiry.',
                    });
                }
            }
        }

        if (hasPostFields) {
            const { data: updatedRows, error: updateError } = await supabase
                .from(CONFIG.tables.posts)
                .update(payload.postFields)
                .eq('id', req.params.id)
                .select('id');

            if (updateError) {
                throw updateError;
            }

            if (!updatedRows || updatedRows.length === 0) {
                return res.status(404).json({ error: 'Post not found' });
            }
        } else {
            const post = await getPostById(req.params.id);
            if (!post) {
                return res.status(404).json({ error: 'Post not found' });
            }
        }

        if (hasTagChanges) {
            await replacePostTags(req.params.id, payload.tagIds, payload.tagNames);
        }

        if (hasRefChanges) {
            await replacePostRef(req.params.id, payload.ref);
        }

        const fullPost = await getPostById(req.params.id);
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

module.exports = { app, server, supabase, CONFIG };
