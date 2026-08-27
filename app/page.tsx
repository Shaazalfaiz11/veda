import { AppShell } from '@/components/layout/AppShell';
import { UploadScreen } from '@/components/upload/UploadScreen';

/**
 * The entry point of the flow the Figma file describes: upload a question
 * paper and an answer sheet, then start processing.
 */
export default function Home() {
  return (
    <AppShell crumb="Exams">
      <UploadScreen />
    </AppShell>
  );
}
