/**
 * Seed Practice Content Assets
 *
 * Pre-populates the practice_content_assets table with example content.
 * Run: npx tsx scripts/seed-content-assets.ts <organization_id>
 *
 * This creates:
 * - Practice info (address, hours, map link)
 * - Example testimonial videos (with YouTube URLs)
 * - Example before/after entries
 * - Procedure info for All-on-4
 * - Financing info summary
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function seedContentAssets(organizationId: string) {
  console.log(`🌱 Seeding content assets for org: ${organizationId}\n`)

  const assets = [
    // ── Practice Info ──────────────────────────────────
    {
      organization_id: organizationId,
      type: 'practice_info',
      title: 'Practice Location & Hours',
      description: 'Main practice address, hours, and directions',
      content: {
        address: '123 Smile Boulevard',
        city: 'Beverly Hills',
        state: 'CA',
        zip: '90210',
        phone: '(310) 555-0100',
        hours: 'Mon-Fri 8AM-5PM, Sat 9AM-2PM',
        map_url: 'https://maps.google.com/?q=123+Smile+Boulevard+Beverly+Hills+CA',
        parking_notes: 'Free parking available in the building lot. Enter from the main street.',
      },
      media_urls: [],
      tags: ['location', 'address', 'directions'],
    },

    // ── Testimonial Videos ──────────────────────────────
    {
      organization_id: organizationId,
      type: 'testimonial_video',
      title: "Maria's All-on-4 Journey",
      description: 'Maria shares her life-changing experience with All-on-4 dental implants',
      content: {
        patient_name: 'Maria',
        procedure: 'All-on-4 Dental Implants',
        quote: "I can smile with confidence again. The whole team made me feel so comfortable from day one. I wish I hadn't waited so long!",
        video_url: 'https://youtube.com/watch?v=example1',
        thumbnail_url: '',
      },
      media_urls: ['https://youtube.com/watch?v=example1'],
      tags: ['all-on-4', 'implants', 'testimonial'],
    },
    {
      organization_id: organizationId,
      type: 'testimonial_video',
      title: "James's Smile Makeover",
      description: 'James talks about how his new smile changed his life',
      content: {
        patient_name: 'James',
        procedure: 'Full Mouth Restoration',
        quote: "I was embarrassed to smile for years. Now I can't stop smiling! The results exceeded my expectations.",
        video_url: 'https://youtube.com/watch?v=example2',
        thumbnail_url: '',
      },
      media_urls: ['https://youtube.com/watch?v=example2'],
      tags: ['full-mouth', 'restoration', 'testimonial'],
    },
    {
      organization_id: organizationId,
      type: 'testimonial_video',
      title: "Sarah's Denture-to-Implant Transformation",
      description: 'Sarah got rid of her dentures and got permanent implants',
      content: {
        patient_name: 'Sarah',
        procedure: 'Denture Replacement with Implants',
        quote: "Going from dentures to permanent implants was the best decision. I can eat anything now and my smile looks completely natural.",
        video_url: 'https://youtube.com/watch?v=example3',
        thumbnail_url: '',
      },
      media_urls: ['https://youtube.com/watch?v=example3'],
      tags: ['dentures', 'implants', 'transformation', 'testimonial'],
    },

    // ── Before/After Photos ──────────────────────────────
    {
      organization_id: organizationId,
      type: 'before_after_photo',
      title: 'All-on-4 Case #1: Complete Transformation',
      description: 'Full upper and lower arch restoration with All-on-4 implants',
      content: {
        patient_name: 'Patient A',
        procedure: 'All-on-4 Upper & Lower',
        description: 'This patient came to us with failing teeth and low confidence. After All-on-4 treatment, they have a beautiful, permanent smile that looks and feels natural.',
        before_url: '',  // Replace with actual Supabase Storage URLs
        after_url: '',
        gallery_url: '',
      },
      media_urls: [],
      tags: ['all-on-4', 'full-arch', 'transformation'],
    },
    {
      organization_id: organizationId,
      type: 'before_after_photo',
      title: 'Denture Replacement Case',
      description: 'From removable dentures to permanent implant-supported teeth',
      content: {
        patient_name: 'Patient B',
        procedure: 'Denture-to-Implant Conversion',
        description: 'After years of struggling with loose dentures, this patient now has secure, permanent teeth that never slip or move. They can eat, laugh, and live without worry.',
        before_url: '',
        after_url: '',
        gallery_url: '',
      },
      media_urls: [],
      tags: ['dentures', 'implants', 'conversion'],
    },

    // ── Procedure Info ──────────────────────────────────
    {
      organization_id: organizationId,
      type: 'procedure_info',
      title: 'All-on-4 Dental Implants',
      description: 'Overview of the All-on-4 procedure',
      content: {
        procedure_name: 'All-on-4® Dental Implants',
        overview: 'All-on-4 is a revolutionary technique that replaces an entire arch of teeth using just four strategically placed implants. You can receive a full set of fixed, natural-looking teeth in a single day — no bone grafting required in most cases.',
        duration: 'Same-day (4-6 hours)',
        recovery: '2-3 weeks for initial healing',
        benefits: [
          'Permanent, non-removable teeth',
          'Eat anything you want — steak, apples, corn on the cob',
          'No more denture adhesives or slipping',
          'Natural-looking smile designed just for you',
          'Preserves jawbone and facial structure',
          'Most patients leave with teeth the same day',
        ],
      },
      media_urls: [],
      tags: ['all-on-4', 'implants', 'procedure'],
    },

    // ── Financing Info ──────────────────────────────────
    {
      organization_id: organizationId,
      type: 'financing_info',
      title: 'Payment & Financing Options',
      description: 'Overview of available payment plans',
      content: {
        summary: 'We believe cost should never stand between you and the smile you deserve. We offer multiple financing options to fit every budget.',
        options: [
          { name: '0% Interest Plans', description: 'Up to 24 months interest-free on approved credit' },
          { name: 'Extended Terms', description: 'Low monthly payments up to 60 months' },
          { name: 'Cash Discount', description: 'Save when you pay in full at the time of treatment' },
          { name: 'Insurance Coordination', description: 'We work with most major dental insurance plans' },
        ],
        apply_url: '',
      },
      media_urls: [],
      tags: ['financing', 'payment', 'options'],
    },
  ]

  let created = 0
  for (const asset of assets) {
    const { data, error } = await supabase
      .from('practice_content_assets')
      .insert(asset)
      .select('id, type, title')
      .single()

    if (error) {
      console.error(`  ❌ Failed: ${asset.title} — ${error.message}`)
    } else {
      console.log(`  ✅ Created: [${data.type}] ${data.title} (${data.id})`)
      created++
    }
  }

  console.log(`\n🎉 Seeded ${created}/${assets.length} content assets`)
}

// ── CLI Entry Point ──────────────────────────────────

const orgId = process.argv[2]
if (!orgId) {
  console.error('Usage: npx tsx scripts/seed-content-assets.ts <organization_id>')
  process.exit(1)
}

seedContentAssets(orgId).catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
