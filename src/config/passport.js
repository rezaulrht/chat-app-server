const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;
const User = require("../models/User");

// Google Strategy
passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: "/auth/google/callback",
            proxy: true,
        },
        async (accessToken, refreshToken, profile, done) => {
            const { id, displayName, emails, photos } = profile;

            // Robust email extraction
            let email = null;
            if (emails && emails.length > 0) {
                email = emails[0].value || emails[0];
            }

            if (!email) {
                return done(new Error("No email found in Google profile"), null);
            }

            const avatar = photos?.[0]?.value || "";

            try {
                // Find user by Google ID or Email
                let user = await User.findOne({
                    $or: [{ providerId: id }, { email }]
                });

                if (user) {
                    // Update user if they exist but don't have provider info
                    if (!user.providerId) {
                        user.provider = "google";
                        user.providerId = id;
                        if (!user.avatar) user.avatar = avatar;
                        await user.save();
                        console.log(`Updated legacy user ${user.email} with Google ID`);
                    }
                    return done(null, user);
                }

                // Create new user if they don't exist
                user = new User({
                    name: displayName || "Google User",
                    email,
                    avatar,
                    provider: "google",
                    providerId: id,
                });

                await user.save();
                console.log(`Created new Google user: ${email}`);
                done(null, user);
            } catch (err) {
                console.error("Google Auth Error:", err);
                done(err, null);
            }
        }
    )
);

// GitHub Strategy
passport.use(
    new GitHubStrategy(
        {
            clientID: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
            callbackURL: "/auth/github/callback",
            proxy: true,
        },
        async (accessToken, refreshToken, profile, done) => {
            let { id, displayName, username, emails, photos } = profile;

            // Robust email extraction
            let email = null;
            if (emails && emails.length > 0) {
                email = emails[0].value || emails[0];
            }

            // If no email in profile (happens with private emails), fetch from GitHub API
            if (!email && accessToken) {
                try {
                    const response = await fetch("https://api.github.com/user/emails", {
                        headers: {
                            Authorization: `token ${accessToken}`,
                            "User-Agent": "ConvoX-Server",
                        },
                    });
                    const fetchedEmails = await response.json();

                    if (Array.isArray(fetchedEmails)) {
                        // Find primary email, otherwise just first one
                        const primaryEmail = fetchedEmails.find(e => e.primary && e.verified) ||
                            fetchedEmails.find(e => e.verified) ||
                            fetchedEmails[0];

                        if (primaryEmail) {
                            email = primaryEmail.email;
                            console.log(`Fetched private email for ${username}: ${email}`);
                        }
                    }
                } catch (fetchErr) {
                    console.error("Error fetching GitHub emails:", fetchErr);
                }
            }

            // Final fallback if still no email found
            if (!email) {
                email = `${username || id}@github.com`;
                console.warn(`Could not fetch real email for ${username}, using fallback: ${email}`);
            }

            const avatar = photos?.[0]?.value || "";

            try {
                // Find user by GitHub ID or Email
                let user = await User.findOne({
                    $or: [{ providerId: id }, { email }]
                });

                if (user) {
                    // Update user if they exist but don't have provider info
                    if (!user.providerId) {
                        user.provider = "github";
                        user.providerId = id;
                        if (!user.avatar) user.avatar = avatar;
                        await user.save();
                        console.log(`Updated legacy user ${user.email} with GitHub ID`);
                    }
                    return done(null, user);
                }

                // Create new user if they don't exist
                user = new User({
                    name: displayName || username || "GitHub User",
                    email,
                    avatar,
                    provider: "github",
                    providerId: id,
                });

                await user.save();
                console.log(`Created new GitHub user: ${email}`);
                done(null, user);
            } catch (err) {
                console.error("GitHub Auth Error:", err);
                done(err, null);
            }
        }
    )
);

module.exports = passport;
