/**
 * Quick SMS test script
 * Usage: npx tsx scripts/test-sms.ts <recipient_phone_number>
 * Example: npx tsx scripts/test-sms.ts +14155551234
 */
import 'dotenv/config'

async function testSMS() {
  const to = process.argv[2]

  if (!to) {
    console.error('❌ Please provide a recipient phone number')
    console.error('Usage: npx tsx scripts/test-sms.ts +14155551234')
    process.exit(1)
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const fromNumber = process.env.TWILIO_PHONE_NUMBER

  console.log('📱 Twilio SMS Test')
  console.log('─'.repeat(40))
  console.log(`Account SID: ${accountSid?.slice(0, 10)}...`)
  console.log(`From Number: ${fromNumber}`)
  console.log(`To Number:   ${to}`)
  console.log('─'.repeat(40))

  if (!accountSid || !authToken || !fromNumber) {
    console.error('❌ Missing Twilio environment variables')
    process.exit(1)
  }

  // Use Twilio REST API directly to avoid any import issues
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64')

  const body = new URLSearchParams({
    To: to,
    From: fromNumber,
    Body: `🧪 Lead Intelligence test message — ${new Date().toLocaleString()}. If you received this, SMS is working!`,
  })

  try {
    console.log('\n⏳ Sending test SMS...')
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })

    const data = await response.json()

    if (response.ok) {
      console.log('\n✅ SMS sent successfully!')
      console.log(`   SID:    ${data.sid}`)
      console.log(`   Status: ${data.status}`)
      console.log(`   To:     ${data.to}`)
      console.log(`   From:   ${data.from}`)
      console.log(`   Price:  ${data.price ?? 'pending'}`)
    } else {
      console.error('\n❌ Failed to send SMS')
      console.error(`   Error Code:    ${data.code}`)
      console.error(`   Error Message: ${data.message}`)
      console.error(`   More Info:     ${data.more_info}`)
    }
  } catch (err) {
    console.error('\n❌ Network error:', err instanceof Error ? err.message : err)
  }
}

testSMS()
