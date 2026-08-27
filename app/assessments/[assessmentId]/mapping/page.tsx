import { AppShell } from '@/components/layout/AppShell';
import { MappingScreen } from '@/components/mapping/MappingScreen';

export const dynamic = 'force-dynamic';

/**
 * /assessments/:assessmentId/mapping — Figma "Question - Answer mapping
 * screen" 1:8861.
 *
 * Uses the collapsed sidebar, as the frame does. All data is fetched by the
 * screen itself from the existing API routes.
 */
export default async function MappingPage({
  params,
}: {
  params: Promise<{ assessmentId: string }>;
}) {
  const { assessmentId } = await params;

  return (
    <AppShell crumb="Exams" sidebar="collapsed" fill>
      <MappingScreen assessmentId={assessmentId} />
    </AppShell>
  );
}
