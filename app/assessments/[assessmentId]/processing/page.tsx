import { AppShell } from '@/components/layout/AppShell';
import { ProcessingScreen } from '@/components/processing/ProcessingScreen';

export const dynamic = 'force-dynamic';

/**
 * /assessments/:assessmentId/processing — Figma "Loading state" 1:9959.
 *
 * The id comes from the route, so this is always the assessment the upload
 * flow actually created. The screen itself polls; nothing is fetched here,
 * which keeps the page a server component with no data of its own to go
 * stale.
 */
export default async function ProcessingPage({
  params,
}: {
  params: Promise<{ assessmentId: string }>;
}) {
  const { assessmentId } = await params;

  return (
    <AppShell crumb="Exams" sidebar="collapsed">
      <ProcessingScreen assessmentId={assessmentId} />
    </AppShell>
  );
}
