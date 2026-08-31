#!/usr/bin/env node
/**
 * Notifications Test Script
 * Run this to verify your email, SMS, and WhatsApp notification setup
 * 
 * Usage: node test-notifications.js
 */

const path = require('path');
const { createNotificationService } = require('./lib/notifications');

const rootDir = __dirname;
const notifications = createNotificationService(path.join(rootDir, 'config'));

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   Starz Shots Gallery - Notifications Test Suite');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const tests = [
    {
      name: 'Email Notification',
      fn: async () => {
        console.log('📧 Testing Email...');
        const result = await notifications.sendEmail(
          'Test Email from Starz Shots',
          `
            <h2>Email Test Successful! ✅</h2>
            <p>This is a test email from your Starz Shots Gallery notification system.</p>
            <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
            <p>If you received this email, your Gmail SMTP configuration is working correctly.</p>
          `
        );
        return result;
      }
    },
    {
      name: 'SMS Notification',
      fn: async () => {
        console.log('📱 Testing SMS...');
        const result = await notifications.sendSMS(
          `✅ Starz Shots Gallery SMS Test - ${new Date().toLocaleTimeString()}`
        );
        return result;
      }
    },
    {
      name: 'WhatsApp Notification',
      fn: async () => {
        console.log('💬 Testing WhatsApp...');
        const result = await notifications.sendWhatsApp(
          `✅ Starz Shots Gallery WhatsApp Test\nTime: ${new Date().toLocaleString()}`
        );
        return result;
      }
    },
    {
      name: 'Event Created Notification',
      fn: async () => {
        console.log('🎉 Testing Event Created Notification...');
        const result = await notifications.notifyEventCreated({
          eventName: 'Test Wedding Event',
          eventDate: '2026-09-15',
          clientCode: 'TEST1234',
          guestCode: 'guest',
          galleryUrl: 'http://localhost:3001/?event=test-wedding',
          googleDriveFolderUrl: 'https://drive.google.com/drive/folders/test-folder-id'
        });
        return true;
      }
    },
    {
      name: 'Photo Cache Completed Notification',
      fn: async () => {
        console.log('🖼️  Testing Photo Cache Completed Notification...');
        const result = await notifications.notifyPhotoCacheCompleted({
          eventName: 'Test Wedding Event',
          photoCount: 256
        });
        return true;
      }
    },
    {
      name: 'Face Index Completed Notification',
      fn: async () => {
        console.log('👤 Testing Face Index Completed Notification...');
        const result = await notifications.notifyFaceIndexCompleted({
          eventName: 'Test Wedding Event',
          faceCount: 42
        });
        return true;
      }
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test.fn();
      console.log(`   ✅ ${test.name} - Sent successfully\n`);
      passed++;
    } catch (error) {
      console.log(`   ❌ ${test.name} - Failed: ${error.message}\n`);
      failed++;
    }
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed === 0) {
    console.log('✅ All tests passed! Your notifications are configured correctly.\n');
    console.log('Next steps:');
    console.log('1. Check your email (including spam folder) for the test email');
    console.log('2. Check SMS on +919962206330');
    console.log('3. Check WhatsApp on +919962206330');
    console.log('\nIf you received all notifications, you\'re good to go! 🎉\n');
  } else {
    console.log(`⚠️  ${failed} notification channel(s) failed.\n`);
    console.log('Troubleshooting steps:');
    console.log('1. Verify config/notifications.json has correct credentials');
    console.log('2. Check that Gmail app password is set (not regular password)');
    console.log('3. Verify Twilio account has sufficient credit');
    console.log('4. Ensure phone numbers are in correct international format (+country-code-number)\n');
  }

  process.exit(failed > 0 ? 1 : 0);
}

console.log('Starting notification tests...\n');
runTests().catch((error) => {
  console.error('❌ Test suite error:', error);
  process.exit(1);
});
