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
            const email = emails[0].value;
            const avatar = photos[0]?.value || "";

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
                    }
                    return done(null, user);
                }

                // Create new user if they don't exist
                user = new User({
                    name: displayName,
                    email,
                    avatar,
                    provider: "google",
                    providerId: id,
                });

                await user.save();
                done(null, user);
            } catch (err) {
                console.error(err);
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
            const { id, displayName, username, emails, photos } = profile;
            const email = emails?.[0]?.value || `${username}@github.com`; // Fallback if email is private
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
                    }
                    return done(null, user);
                }

                // Create new user if they don't exist
                user = new User({
                    name: displayName || username,
                    email,
                    avatar,
                    provider: "github",
                    providerId: id,
                });

                await user.save();
                done(null, user);
            } catch (err) {
                console.error(err);
                done(err, null);
            }
        }
    )
);

module.exports = passport;
