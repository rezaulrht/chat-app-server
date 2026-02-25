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

            let avatar = photos?.[0]?.value || "";
            if (avatar) avatar = avatar.replace(/=s\d+[^"']*/g, "");

            try {
                // Find user by Google ID or Email
                let user = await User.findOne({
                    $or: [{ providerId: id }, { email }]
                });

                if (user) {
                    // Always refresh avatar from the latest OAuth profile
                    if (avatar) user.avatar = avatar;
                    if (!user.providerId) {
                        user.provider = "google";
                        user.providerId = id;
                        user.isVerified = true;
                    }
                    await user.save();
                    return done(null, user);
                }

                // Create new user if they don't exist
                user = new User({
                    name: displayName || "Google User",
                    email,
                    avatar,
                    provider: "google",
                    providerId: id,
                    isVerified: true,
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

            // GitHub avatar URLs can include size query params — strip for canonical URL.
            let avatar = photos?.[0]?.value || "";
            if (avatar) avatar = avatar.replace(/[?&]v=\d+/g, "").replace(/&s=\d+/g, "");

            try {
                // Find user by GitHub ID or Email
                let user = await User.findOne({
                    $or: [{ providerId: id }, { email }]
                });

                if (user) {
                    // Always refresh avatar from the latest OAuth profile so
                    // stale/empty URLs self-heal on the next login.
                    if (avatar) user.avatar = avatar;
                    if (!user.providerId) {
                        user.provider = "github";
                        user.providerId = id;
                        user.isVerified = true;
                    }
                    await user.save();
                    return done(null, user);
                }

                // Create new user if they don't exist
                user = new User({
                    name: displayName || username || "GitHub User",
                    email,
                    avatar,
                    provider: "github",
                    providerId: id,
                    isVerified: true,
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
