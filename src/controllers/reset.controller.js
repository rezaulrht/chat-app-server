const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const SibApiV3Sdk = require("sib-api-v3-sdk");
const User = require("../models/User");

exports.sendResetEmail = async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Generate raw token
    const rawToken = crypto.randomBytes(32).toString("hex");

    // Hash token before saving to DB (security best practice)
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    user.resetToken = hashedToken;
    user.resetTokenExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
    await user.save();

    // Brevo config
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications["api-key"];
    apiKey.apiKey = process.env.BREVO_API_KEY;

    const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

    const resetLink = `${process.env.SITE_URL}/reset-password?token=${rawToken}`;

    await tranEmailApi.sendTransacEmail({
      sender: {
        email: "rezaulrahaat@gmail.com",
        name: "ConvoX Support",
      },
      to: [{ email }],
      subject: "Reset Your Password - ConvoX",
      htmlContent: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset Your Password - ConvoX</title>
      </head>
      <body style="margin: 0; padding: 0; background-color: #05050A; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #ffffff;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color: #05050A; padding: 40px 20px;">
              <tr>
                  <td align="center">
                      <table class="container" width="100%" max-width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width: 600px; background-color: #111418; border-radius: 16px; border: 1px solid rgba(255,255,255,0.05); overflow: hidden;">
                          <!-- Header -->
                          <tr>
                              <td style="padding: 40px 40px 20px; text-align: center;">
                                  <img src="https://i.ibb.co/PG0X3Tbf/Convo-X-logo.png" alt="ConvoX Logo" style="height: 48px; width: auto; border: 0;" />
                              </td>
                          </tr>
                          
                          <!-- Content -->
                          <tr>
                              <td style="padding: 0 40px 30px; text-align: center;">
                                  <h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: #ffffff;">Password Reset Request</h2>
                                  <p style="margin: 0 0 32px; font-size: 15px; line-height: 1.6; color: #94a3b8;">
                                      We received a request to reset your password. If you didn't make this request, you can safely ignore this email.
                                  </p>
                                  
                                  <!-- Reset Button -->
                                  <div style="margin-bottom: 32px;">
                                      <a href="${resetLink}" target="_blank" style="display: inline-block; background-color: #13c8ec; color: #05050A; font-size: 15px; font-weight: 700; text-decoration: none; padding: 12px 32px; border-radius: 8px; box-shadow: 0 4px 12px rgba(19,200,236,0.3);">
                                          Reset Password
                                      </a>
                                  </div>
                                  
                                  <p style="margin: 0 0 16px; font-size: 14px; color: #64748b;">
                                      This link will expire in 10 minutes.<br>
                                      <span style="font-size: 12px;">If you're having trouble clicking the button, copy and paste this link: ${resetLink}</span>
                                  </p>
                              </td>
                          </tr>
                          
                          <!-- Footer -->
                          <tr>
                              <td style="padding: 24px 40px; background-color: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.05); text-align: center;">
                                  <p style="margin: 0; font-size: 12px; color: #475569;">
                                      &copy; ${new Date().getFullYear()} ConvoX. All rights reserved.<br>
                                      Securing your communications, one message at a time.
                                  </p>
                              </td>
                          </tr>
                      </table>
                  </td>
              </tr>
          </table>
      </body>
      </html>
    `,
    });

    return res.json({
      success: true,
      message: "Password reset link sent successfully",
    });
  } catch (error) {
    console.error("RESET EMAIL ERROR:", error.response?.body || error);
    return res.status(500).json({
      success: false,
      message: "Server error while sending reset email",
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Token and new password are required",
      });
    }

    // Hash incoming token to match DB
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetToken: hashedToken,
      resetTokenExpiry: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset token",
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;

    // Clear reset fields
    user.resetToken = null;
    user.resetTokenExpiry = null;

    await user.save();

    return res.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    console.error("RESET PASSWORD ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while resetting password",
    });
  }
};
