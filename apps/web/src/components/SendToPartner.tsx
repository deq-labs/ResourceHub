import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, idempotent, unwrap } from '@/lib/api';
import { Button, Select } from './ui';

/** Push this resource to a partner system (e.g. SOAP SubmitDocument). Runs as a worker job. */
export function SendToPartner({ resourceId }: { resourceId: string }) {
  const [integrationId, setIntegrationId] = useState('');
  const list = useQuery({
    queryKey: ['integrations'],
    queryFn: async () => unwrap(await api.GET('/api/v1/integrations')).data,
  });
  const targets = (list.data ?? []).filter((i) => i.supportsPush && i.enabled);
  const push = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/integrations/push', {
          params: idempotent(),
          body: { integrationId, resourceId },
        }),
      ),
    onSuccess: () => toast.success('Queued for delivery. Track it under Admin › Integrations.'),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (targets.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
        Send to partner
      </h3>
      <div className="flex gap-2">
        <Select
          aria-label="Partner"
          value={integrationId}
          onChange={(e) => setIntegrationId(e.target.value)}
        >
          <option value="">Choose…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Button
          size="icon"
          variant="secondary"
          disabled={!integrationId}
          loading={push.isPending}
          onClick={() => push.mutate()}
          aria-label="Send"
        >
          {!push.isPending && <Send />}
        </Button>
      </div>
    </div>
  );
}
