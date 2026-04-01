-- Post service schema (MVP)
-- Run this in Supabase SQL editor (adjust schema if you use a non-public schema).

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists public.posts (
    id uuid primary key default gen_random_uuid(),
    type text not null default 'GENERAL',
    title text,
    summary text,
    author_id uuid,
    status text not null default 'draft',
    expires_at timestamptz,
    pinned boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint posts_status_check check (status in ('draft', 'published', 'archived'))
);

alter table if exists public.posts
    alter column type set default 'GENERAL';

create table if not exists public.tags (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    slug text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists public.post_tags (
    post_id uuid not null references public.posts(id) on delete cascade,
    tag_id uuid not null references public.tags(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (post_id, tag_id)
);

create table if not exists public.post_refs (
    id uuid primary key default gen_random_uuid(),
    post_id uuid not null references public.posts(id) on delete cascade,
    service text not null,
    entity_id text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.post_votes (
    post_id uuid not null references public.posts(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    vote smallint not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint post_votes_vote_check check (vote in (-1, 1)),
    primary key (post_id, user_id)
);

create table if not exists public.post_comments (
    id uuid primary key default gen_random_uuid(),
    post_id uuid not null references public.posts(id) on delete cascade,
    author_id uuid not null references public.users(id) on delete cascade,
    content text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint post_comments_content_check check (char_length(trim(content)) > 0)
);

create table if not exists public.event_volunteer_enrollments (
    id uuid primary key default gen_random_uuid(),
    post_id uuid not null references public.posts(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    full_name text not null,
    contact_info text not null,
    reason text not null,
    availability text,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint event_volunteer_enrollments_full_name_check check (char_length(trim(full_name)) > 0),
    constraint event_volunteer_enrollments_contact_info_check check (char_length(trim(contact_info)) > 0),
    constraint event_volunteer_enrollments_reason_check check (char_length(trim(reason)) > 0),
    constraint event_volunteer_enrollments_availability_check check (availability is null or char_length(trim(availability)) > 0),
    constraint event_volunteer_enrollments_notes_check check (notes is null or char_length(trim(notes)) > 0),
    unique (post_id, user_id)
);

create table if not exists public.collab_posts (
    post_id uuid primary key references public.posts(id) on delete cascade,
    category text not null,
    description text not null,
    mode text not null default 'hybrid',
    time_commitment_hours_per_week integer not null default 1,
    duration text not null,
    openings integer not null default 1,
    preferred_background text,
    deadline timestamptz,
    status text not null default 'open',
    contact_method text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint collab_posts_mode_check check (mode in ('remote', 'onsite', 'hybrid')),
    constraint collab_posts_status_check check (status in ('open', 'closed')),
    constraint collab_posts_openings_check check (openings > 0),
    constraint collab_posts_time_commitment_check check (time_commitment_hours_per_week > 0),
    constraint collab_posts_category_check check (char_length(trim(category)) > 0),
    constraint collab_posts_description_check check (char_length(trim(description)) > 0),
    constraint collab_posts_duration_check check (char_length(trim(duration)) > 0)
);

create table if not exists public.collab_skills (
    id uuid primary key default gen_random_uuid(),
    post_id uuid not null references public.collab_posts(post_id) on delete cascade,
    skill text not null,
    created_at timestamptz not null default now(),
    constraint collab_skills_skill_check check (char_length(trim(skill)) > 0)
);

create table if not exists public.collab_join_requests (
    id uuid primary key default gen_random_uuid(),
    post_id uuid not null references public.collab_posts(post_id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    message text,
    status text not null default 'pending',
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint collab_join_requests_status_check check (status in ('pending', 'accepted', 'rejected')),
    constraint collab_join_requests_message_check check (message is null or char_length(trim(message)) > 0),
    unique (post_id, user_id)
);

create table if not exists public.collab_memberships (
    id uuid primary key default gen_random_uuid(),
    post_id uuid not null references public.collab_posts(post_id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    team_role text,
    created_at timestamptz not null default now(),
    unique (post_id, user_id)
);

create table if not exists public.newsletter_issues (
    id uuid primary key default gen_random_uuid(),
    issue_month text not null unique,
    issue_date date not null,
    subject text not null default '',
    html_body text not null default '',
    text_body text not null default '',
    content_summary jsonb not null default '{}'::jsonb,
    status text not null default 'draft',
    published_at timestamptz,
    last_generated_at timestamptz,
    last_sent_at timestamptz,
    last_send_trigger text,
    last_send_initiated_by uuid references public.users(id) on delete set null,
    last_send_counts jsonb not null default '{}'::jsonb,
    last_error text,
    automatic_send_started_at timestamptz,
    automatic_sent_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint newsletter_issues_issue_month_check check (issue_month ~ '^[0-9]{4}-[0-9]{2}$'),
    constraint newsletter_issues_status_check check (status in ('draft', 'sending', 'sent', 'partial', 'failed', 'skipped')),
    constraint newsletter_issues_trigger_check check (last_send_trigger is null or last_send_trigger in ('manual', 'automatic'))
);

create table if not exists public.newsletter_send_runs (
    id uuid primary key default gen_random_uuid(),
    issue_id uuid not null references public.newsletter_issues(id) on delete cascade,
    trigger_type text not null,
    initiated_by uuid references public.users(id) on delete set null,
    subject text not null default '',
    total_users integer not null default 0,
    valid_emails integer not null default 0,
    skipped_invalid_emails integer not null default 0,
    skipped_duplicate_emails integer not null default 0,
    attempted_count integer not null default 0,
    sent_count integer not null default 0,
    failed_count integer not null default 0,
    status text not null default 'running',
    error_message text,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint newsletter_send_runs_trigger_check check (trigger_type in ('manual', 'automatic')),
    constraint newsletter_send_runs_status_check check (status in ('running', 'sent', 'partial', 'failed', 'skipped')),
    constraint newsletter_send_runs_total_users_check check (total_users >= 0),
    constraint newsletter_send_runs_valid_emails_check check (valid_emails >= 0),
    constraint newsletter_send_runs_skipped_invalid_check check (skipped_invalid_emails >= 0),
    constraint newsletter_send_runs_skipped_duplicate_check check (skipped_duplicate_emails >= 0),
    constraint newsletter_send_runs_attempted_check check (attempted_count >= 0),
    constraint newsletter_send_runs_sent_check check (sent_count >= 0),
    constraint newsletter_send_runs_failed_check check (failed_count >= 0)
);

create table if not exists public.newsletter_settings (
    id boolean primary key default true,
    auto_send_enabled boolean not null default true,
    updated_by uuid references public.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint newsletter_settings_singleton_check check (id = true)
);

insert into public.newsletter_settings (id, auto_send_enabled)
values (true, true)
on conflict (id) do nothing;

create index if not exists idx_posts_status_created_at
    on public.posts (status, created_at desc);

create index if not exists idx_posts_pinned_created_at
    on public.posts (pinned desc, created_at desc);

create index if not exists idx_posts_type_status_created_at
    on public.posts (type, status, created_at desc);

create index if not exists idx_posts_expires_at
    on public.posts (expires_at);

create index if not exists idx_posts_author_id
    on public.posts (author_id);

create index if not exists idx_tags_name
    on public.tags (name);

create index if not exists idx_post_tags_tag_id
    on public.post_tags (tag_id);

create index if not exists idx_post_refs_post_id
    on public.post_refs (post_id);

create index if not exists idx_post_votes_user_id
    on public.post_votes (user_id);

create index if not exists idx_post_votes_post_vote
    on public.post_votes (post_id, vote);

create index if not exists idx_post_comments_post_created_at
    on public.post_comments (post_id, created_at desc);

create index if not exists idx_post_comments_author_id
    on public.post_comments (author_id);

create index if not exists idx_event_volunteer_enrollments_post_created_at
    on public.event_volunteer_enrollments (post_id, created_at desc);

create index if not exists idx_event_volunteer_enrollments_user_id
    on public.event_volunteer_enrollments (user_id);

create index if not exists idx_collab_posts_category
    on public.collab_posts (category);

create index if not exists idx_collab_posts_mode_status
    on public.collab_posts (mode, status);

create index if not exists idx_collab_posts_deadline
    on public.collab_posts (deadline);

create index if not exists idx_collab_posts_created_at
    on public.collab_posts (created_at desc);

create index if not exists idx_collab_skills_post_id
    on public.collab_skills (post_id);

create unique index if not exists idx_collab_skills_post_skill_lower
    on public.collab_skills (post_id, lower(skill));

create index if not exists idx_collab_skills_skill_lower
    on public.collab_skills (lower(skill));

create index if not exists idx_collab_join_requests_post_status
    on public.collab_join_requests (post_id, status, created_at desc);

create index if not exists idx_collab_join_requests_user_id
    on public.collab_join_requests (user_id);

create index if not exists idx_collab_memberships_post_id
    on public.collab_memberships (post_id, created_at desc);

create index if not exists idx_collab_memberships_user_id
    on public.collab_memberships (user_id);

create index if not exists idx_newsletter_issues_published_at
    on public.newsletter_issues (published_at desc);

create index if not exists idx_newsletter_issues_status
    on public.newsletter_issues (status, updated_at desc);

create index if not exists idx_newsletter_issues_automatic
    on public.newsletter_issues (issue_month, automatic_sent_at, automatic_send_started_at);

create index if not exists idx_newsletter_send_runs_issue_started
    on public.newsletter_send_runs (issue_id, started_at desc);

create index if not exists idx_newsletter_send_runs_trigger_started
    on public.newsletter_send_runs (trigger_type, started_at desc);

create index if not exists idx_newsletter_settings_updated_at
    on public.newsletter_settings (updated_at desc);

-- Search performance indexes (used by GET /search in post-service).
create index if not exists idx_posts_search_fts
    on public.posts
    using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '')));

create index if not exists idx_tags_name_trgm
    on public.tags
    using gin (name gin_trgm_ops);

create index if not exists idx_tags_slug_trgm
    on public.tags
    using gin (slug gin_trgm_ops);
