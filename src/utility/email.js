const { BrevoClient } = require("@getbrevo/brevo");

/**
 * Sends an OTP validation code to the given user email using Brevo.
 *
 * @param {string} to_email - The email address to send the OTP to.
 * @param {string} to_name - The name of the user receiving the code.
 * @param {string} otp_code - The 6-digit OTP code to send.
 */
const sendOTP = async (to_email, to_name, otp_code) => {
    try {
        const brevo = new BrevoClient({
            apiKey: process.env.BREVO_API_KEY,
        });

        const data = await brevo.transactionalEmails.sendTransacEmail({
            subject: "Your Verification Code - ConvoX",
            htmlContent: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>ConvoX Verification</title>
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
                                  <h2 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: #ffffff;">Verify your email address</h2>
                                  <p style="margin: 0 0 32px; font-size: 15px; line-height: 1.6; color: #94a3b8;">
                                      Hi <span style="font-weight: 700; color: #ffffff;">${to_name}</span>,<br><br>
                                      Thanks for starting the new account creation process. We want to make sure it's really you. Please enter the following verification code when prompted.
                                  </p>
                                  
                                  <!-- OTP Box -->
                                  <div style="background: linear-gradient(145deg, rgba(19,200,236,0.1) 0%, rgba(19,200,236,0.02) 100%); border: 1px solid rgba(19,200,236,0.2); border-radius: 12px; padding: 24px; margin-bottom: 32px;">
                                      <div style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 36px; font-weight: 700; color: #13c8ec; letter-spacing: 8px;">
                                          ${otp_code}
                                      </div>
                                  </div>
                                  
                                  <p style="margin: 0 0 16px; font-size: 14px; color: #64748b;">
                                      This code will expire in 10 minutes.<br>
                                      <span style="font-size: 12px;">If you didn't request this email, you can safely ignore it.</span>
                                  </p>
                              </td>
                          </tr>
                          
                          <!-- Footer -->
                          <tr>
                              <td style="padding: 24px 40px; background-color: rgba(0,0,0,0.2); border-top: 1px solid rgba(255,255,255,0.05); text-align: center;">
                                  <p style="margin: 0; font-size: 12px; color: #475569;">
                                      &copy; ${new Date().getFullYear()} ConvoX. All rights reserved.<br>
                                      You received this email because you signed up for ConvoX.
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
            sender: { name: "ConvoX", email: "rezaulrahaat@gmail.com" },
            to: [{ email: to_email, name: to_name }],
        });

        console.log("OTP email sent successfully via Brevo.");
        return data;
    } catch (error) {
        console.error("Error sending OTP email via Brevo:", error);
        throw new Error("Failed to send OTP email.");
    }
};

module.exports = { sendOTP };
