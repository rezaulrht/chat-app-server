import SibApiV3Sdk from "sib-api-v3-sdk";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

export async function POST(req) {
  const { email } = await req.json();

  if (!email) {
    return new Response(JSON.stringify({ error: "Email is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    await client.connect();
    const db = client.db("ConvoX");
    const users = db.collection("users");

    const user = await users.findOne({ email });
    if (!user) {
      return new Response(JSON.stringify({ error: "user-not-found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Generate reset token (simple example)
    const token = Math.random().toString(36).substring(2, 12);

    await users.updateOne(
      { email },
      { $set: { resetToken: token, resetTokenExpiry: Date.now() + 3600000 } },
    );

    // Brevo Email setup
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications["api-key"];
    apiKey.apiKey = process.env.BREVO_API_KEY;

    const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail({
      to: [{ email }],
      templateId: 1, // Create template in Brevo and use its ID
      params: {
        reset_link: `${process.env.SITE_URL}/reset-password?token=${token}`,
      },
      headers: { "X-Mailer": "Brevo Nodejs SDK" },
    });

    await tranEmailApi.sendTransacEmail(sendSmtpEmail);

    return new Response(JSON.stringify({ message: "Reset email sent" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    await client.close();
  }
}
