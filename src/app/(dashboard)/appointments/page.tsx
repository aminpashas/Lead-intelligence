import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Calendar } from 'lucide-react'
import { format } from 'date-fns'

const statusColors: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-700',
  confirmed: 'bg-green-100 text-green-700',
  completed: 'bg-gray-100 text-gray-700',
  no_show: 'bg-red-100 text-red-700',
  canceled: 'bg-gray-50 text-gray-400',
}

export default async function AppointmentsPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, lead:leads(first_name, last_name, phone, email)')
    .eq('organization_id', profile.organization_id)
    .order('scheduled_at', { ascending: true })
    .limit(100)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Appointments</h1>
        <p className="text-muted-foreground">
          Consultations, follow-ups, and treatment appointments
        </p>
      </div>

      {(!appointments || appointments.length === 0) ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12">
            <Calendar className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="font-medium">No appointments scheduled</p>
            <p className="text-sm text-muted-foreground">
              Appointments will appear here when leads are scheduled for consultations
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {appointments.map((apt) => (
            <Card key={apt.id}>
              <CardContent className="py-3 flex items-center justify-between">
                <div>
                  <p className="font-medium">
                    {(apt.lead as any)?.first_name} {(apt.lead as any)?.last_name}
                  </p>
                  <p className="text-sm text-muted-foreground capitalize">{apt.type}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge className={statusColors[apt.status]}>{apt.status}</Badge>
                  <span className="text-sm font-medium">
                    {format(new Date(apt.scheduled_at), 'MMM d, yyyy h:mm a')}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
