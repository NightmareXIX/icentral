require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY 
);

const JWT_SECRET = process.env.JWT_SECRET || 'HelloWorldKey';
const ALUMNI_VERIFICATION_TABLE = process.env.ALUMNI_VERIFICATION_TABLE || 'alumni_verification_applications';
const BLOCKED_EMAIL_DOMAINS = new Set([
    'example.com',
    'example.net',
    'example.org',
    'localhost',
    'test.com',
]);
const BLOCKED_EMAIL_TLDS = new Set([
    'example',
    'invalid',
    'local',
    'localhost',
    'test',
]);

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isValidEmailAddress(value) {
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

    if (BLOCKED_EMAIL_DOMAINS.has(normalizedDomain) || BLOCKED_EMAIL_TLDS.has(tld)) {
        return false;
    }

    return true;
}

function isMissingTableError(error) {
    return error?.code === '42P01';
}

function resolveVerificationStatus(rows) {
    const applications = Array.isArray(rows) ? rows : [];
    if (applications.some((item) => item.status === 'approved')) return 'approved';
    if (applications.some((item) => item.status === 'pending')) return 'pending';
    if (applications.some((item) => item.status === 'rejected')) return 'rejected';
    return 'not_submitted';
}

async function getAlumniVerificationStatus(userId, role) {
    if (String(role || '').toLowerCase() !== 'alumni') {
        return null;
    }

    const { data, error } = await supabase
        .from(ALUMNI_VERIFICATION_TABLE)
        .select('status, created_at')
        .eq('applicant_id', userId)
        .order('created_at', { ascending: false });

    if (error) {
        if (isMissingTableError(error)) {
            return 'not_submitted';
        }
        throw error;
    }

    return resolveVerificationStatus(data || []);
}

async function signup(req, res) {
    const {university_id, full_name, session, email, phone_number, role, password} = req.body;
    const normalizedEmail = normalizeText(email).toLowerCase();

    if (!isValidEmailAddress(normalizedEmail)) {
        return res.status(400).json({success: false, message: 'Provide a valid email address'});
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const {data, error} = await supabase
            .from('users')
            .insert([{
                university_id,
                full_name,
                session,
                email: normalizedEmail,
                phone_number,
                role,
                password_hash: hashedPassword
            }])
            .select('id, email, role, full_name')
            .single();

        if (error) throw error;

        const verificationStatus = await getAlumniVerificationStatus(data.id, data.role);

        res.status(201).json({
            success: true,
            message: 'Registration successful',
            user: {
                ...data,
                alumniVerificationStatus: verificationStatus,
                isVerifiedAlumni: verificationStatus === 'approved',
            },
        });
    } catch (err) {
        console.error(err);
        res.status(400).json({success: false, message: 'Registration failed, Email or ID might be already exists'});
    }
};

async function login(req, res) {
    const {email, password} = req.body;

    try {
        const {data: user, error} = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if(error || !user) {
            return res.status(401).json({success: false, message: 'Invalid credentials'});
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if(!isMatch) {
            return res.status(401).json({success: false, message: 'Invalid credentials'});
        }

        const token = jwt.sign(
            {
                id: user.id,
                role: user.role,
                email: user.email
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        const verificationStatus = await getAlumniVerificationStatus(user.id, user.role);

        res.status(200).json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                full_name: user.full_name,
                alumniVerificationStatus: verificationStatus,
                isVerifiedAlumni: verificationStatus === 'approved',
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({success: false, message: 'Server error during login'});
    }
};

module.exports = {
    signup,
    login
};
