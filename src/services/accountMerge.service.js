/**
 * Account Merge Service
 * Handles linking multiple social providers to a single user account
 * Enables seamless OAuth cross-provider login
 */

const User = require("../models/User");

/**
 * Link a social account to an existing user by email match
 * If user exists with same email, adds the new provider
 * If not, creates new user with both email and provider
 *
 * @param {string} email - Email address from OAuth provider
 * @param {string} provider - 'google' or 'github'
 * @param {string} providerId - ID from OAuth provider
 * @param {object} userData - Additional data from provider { name, avatar, ... }
 * @returns {object} { user, isNewUser, merged }
 */
async function linkSocialAccountToExisting(
    email,
    provider,
    providerId,
    userData = {}
) {
    if (!email || !provider || !providerId) {
        throw new Error("Email, provider, and providerId are required");
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists by email
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
        // User exists — link new provider if not already linked
        const providerKey = `socialConnections.${provider}`;

        // Check if this provider is already linked to this user
        if (existingUser.socialConnections?.[provider]?.providerId === providerId) {
            return {
                user: existingUser,
                isNewUser: false,
                merged: false,
                message: "Provider already linked to this account",
            };
        }

        // Add/update the new provider to the account
        existingUser.socialConnections = existingUser.socialConnections || {};
        existingUser.socialConnections[provider] = {
            username: userData.username || userData.name || null,
            providerId,
            connectedAt: new Date(),
        };

        // Update avatar if not set or if we want to prefer newer avatar
        if (!existingUser.avatar && userData.avatar) {
            existingUser.avatar = userData.avatar;
        }

        await existingUser.save();

        return {
            user: existingUser,
            isNewUser: false,
            merged: true,
            message: `${provider} account linked to existing user`,
        };
    } else {
        // User doesn't exist — create new user with the provider
        const newUser = await User.create({
            name: userData.name || "New User",
            email: normalizedEmail,
            avatar: userData.avatar || "",
            provider,
            providerId,
            isVerified: true, // OAuth users are pre-verified
            socialConnections: {
                [provider]: {
                    username: userData.username || userData.name || null,
                    providerId,
                    connectedAt: new Date(),
                },
            },
        });

        return {
            user: newUser,
            isNewUser: true,
            merged: false,
            message: "New user created with OAuth provider",
        };
    }
}

/**
 * Check if a social account conflicts with an existing user
 * (e.g., same email already exists but with different provider)
 *
 * @param {string} email
 * @param {string} provider
 * @param {string} providerId
 * @returns {object} { conflicts: bool, existingUser: object | null }
 */
async function checkAccountConflict(email, provider, providerId) {
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (!existingUser) {
        return { conflicts: false, existingUser: null };
    }

    // If the user already has this provider ID linked, no conflict
    if (
        existingUser.socialConnections?.[provider]?.providerId === providerId
    ) {
        return { conflicts: false, existingUser };
    }

    return { conflicts: true, existingUser };
}

/**
 * Disconnect a provider from a user's account
 * Ensures user has at least one login method (email or other OAuth)
 *
 * @param {string} userId
 * @param {string} provider - 'google' or 'github'
 * @returns {object} Updated user
 */
async function disconnectProvider(userId, provider) {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error("User not found");
    }

    // Check if user has password (local auth) or other providers with meaningful content
    const hasLocalAuth = !!user.password;
    const otherProviders = Object.keys(user.socialConnections || {}).filter(
        (p) => p !== provider && user.socialConnections[p]?.providerId
    );

    if (!hasLocalAuth && otherProviders.length === 0) {
        throw new Error(
            "Cannot disconnect the only login method. Add an email password or link another provider first."
        );
    }

    // Remove the provider
    if (user.socialConnections?.[provider]) {
        delete user.socialConnections[provider];
        await user.save();
    }

    return user;
}

module.exports = {
    linkSocialAccountToExisting,
    checkAccountConflict,
    disconnectProvider,
};
