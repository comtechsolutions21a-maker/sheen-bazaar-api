// One-time script to promote a user to admin, run directly on Render (which
// already has a working MONGO_URI) so you don't need to log into MongoDB
// Atlas's website at all — useful when Atlas GitHub SSO login is broken.
//
// Usage (from Render Shell, in the backend's root folder):
//   node scripts/makeAdmin.js youremail@example.com
//
// Safe to delete this file afterwards, or leave it — it does nothing unless
// explicitly run with `node scripts/makeAdmin.js <email>`.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function run() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/makeAdmin.js youremail@example.com');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    console.error(`No account found with email: ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Found account: ${user.name} (${user.email}) — current role: ${user.role}`);
  user.role = 'admin';
  await user.save();
  console.log(`✅ Success — ${user.email} is now an admin.`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
