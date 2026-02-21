const emailjs = require("@emailjs/nodejs");

/**
 * @param {string} to_email - The email address to send the OTP to.
 * @param {string} to_name - The name of the user receiving the code.
 * @param {string} otp_code - The 6-digit OTP code to send.
 */
const sendOTP = async (to_email, to_name, otp_code) => {
    try {
        const templateParams = {
            to_email,
            to_name,
            otp_code,
        };

        const response = await emailjs.send(
            process.env.EMAILJS_SERVICE_ID,
            process.env.EMAILJS_TEMPLATE_ID,
            templateParams,
            {
                publicKey: process.env.EMAILJS_PUBLIC_KEY,
                privateKey: process.env.EMAILJS_PRIVATE_KEY,
            }
        );

        console.log("OTP email sent successfully via EmailJS!");
        return response;
    } catch (error) {
        console.error("Error sending OTP email via EmailJS:", error);
        throw new Error("Failed to send OTP email.");
    }
};

module.exports = { sendOTP };
