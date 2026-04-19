import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { analyzeDentalImage, aggregateCaseAnalysis } from '@/lib/ai/case-analyzer'

/**
 * POST /api/cases/[id]/files — Upload files to a case, trigger AI analysis
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .eq('id', user.id)
    .single()
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  // Verify case exists and belongs to this org
  const { data: existingCase } = await supabase
    .from('clinical_cases')
    .select('id, organization_id, chief_complaint')
    .eq('id', caseId)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!existingCase) {
    return NextResponse.json({ error: 'Case not found' }, { status: 404 })
  }

  const formData = await request.formData()
  const files = formData.getAll('files') as File[]
  const fileTypes = formData.getAll('file_types') as string[]

  if (files.length === 0) {
    return NextResponse.json({ error: 'No files provided' }, { status: 400 })
  }

  const uploadedFiles = []
  const analysisResults = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fileType = fileTypes[i] || 'photo'

    // Upload to Supabase Storage
    const fileExt = file.name.split('.').pop() || 'bin'
    const storagePath = `${profile.organization_id}/${caseId}/${crypto.randomUUID()}.${fileExt}`

    const arrayBuffer = await file.arrayBuffer()
    const { error: uploadError } = await supabase.storage
      .from('case-files')
      .upload(storagePath, arrayBuffer, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      console.error('[CaseFiles] Upload error:', uploadError.message)
      continue
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('case-files')
      .getPublicUrl(storagePath)

    const fileUrl = urlData.publicUrl

    // Create case_files record
    const { data: fileRecord, error: dbError } = await supabase
      .from('case_files')
      .insert({
        case_id: caseId,
        organization_id: profile.organization_id,
        file_name: file.name,
        file_url: fileUrl,
        file_size: file.size,
        mime_type: file.type,
        file_type: fileType,
        uploaded_by: user.id,
        sort_order: i,
      })
      .select()
      .single()

    if (dbError) {
      console.error('[CaseFiles] DB error:', dbError.message)
      continue
    }

    uploadedFiles.push(fileRecord)

    // Trigger AI analysis for image files
    if (file.type.startsWith('image/') || ['xray', 'panoramic', 'periapical', 'cephalometric', 'intraoral', 'extraoral', 'photo'].includes(fileType)) {
      try {
        const analysis = await analyzeDentalImage(
          fileUrl,
          fileType,
          existingCase.chief_complaint
        )

        if (analysis) {
          // Update file record with AI analysis
          await supabase
            .from('case_files')
            .update({
              ai_analysis: analysis,
              ai_analyzed_at: new Date().toISOString(),
              ai_confidence: analysis.confidence,
            })
            .eq('id', fileRecord.id)

          analysisResults.push({ fileType, analysis })
        }
      } catch (err) {
        console.error('[CaseFiles] AI analysis error:', err)
      }
    }
  }

  // If we have analysis results, aggregate and update the case
  if (analysisResults.length > 0) {
    const aggregated = aggregateCaseAnalysis(analysisResults)

    await supabase
      .from('clinical_cases')
      .update({
        ai_analysis_summary: aggregated,
        ai_analyzed_at: new Date().toISOString(),
        status: 'diagnosis', // Move to diagnosis stage after analysis
      })
      .eq('id', caseId)
  } else if (uploadedFiles.length > 0) {
    // Files uploaded but no AI analysis — move to analysis stage
    await supabase
      .from('clinical_cases')
      .update({ status: 'analysis' })
      .eq('id', caseId)
  }

  return NextResponse.json({
    files: uploadedFiles,
    analysis_count: analysisResults.length,
  })
}
