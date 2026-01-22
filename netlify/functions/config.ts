
import { Handler } from "@netlify/functions";

export const handler: Handler = async (event, context) => {
  /**
   * এখানে ২ ভাবে ইন্সট্রাকশন সেট করা যায়:
   * ১. process.env.SYSTEM_INSTRUCTION: যা আপনি নেটলিফাই ড্যাশবোর্ড থেকে সেট করবেন (প্রফেশনাল উপায়)
   * ২. নিচের কোটেশনের ভেতর: যা কোড রান করার সময় ডিফল্ট হিসেবে কাজ করবে।
   */
  
  const customInstruction = "আপনি একজন দক্ষ বাংলা এআই অ্যাসিস্ট্যান্ট। আপনার কাজ হলো ব্যবহারকারীকে সুন্দরভাবে বাংলায় তথ্য দিয়ে সাহায্য করা। আপনার কথা হবে স্পষ্ট এবং মার্জিত।";
  
  const systemInstruction = process.env.SYSTEM_INSTRUCTION || customInstruction;
  const voiceName = process.env.VOICE_NAME || "Puck";

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({
      systemInstruction,
      voiceName,
    }),
  };
};
