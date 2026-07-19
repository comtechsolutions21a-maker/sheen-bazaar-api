// Promotes an existing user to the 'admin' role. Admin accounts are never created
// through the public signup form, so this is how you mint the first admin.
//
// Usage:
//   node scripts/makeAdmin.js someone@example.com
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');

async function run() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/makeAdmin.js <email>');
    process.exit(1);
  }

  await connectDB();
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    console.error(`No user found with email ${email}. Sign up first, then run this script.`);
    process.exit(1);
  }

  user.role = 'admin';
  await user.save();
  console.log(`${user.email} is now an admin.`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
