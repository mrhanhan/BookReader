import { EmptyState } from '@bookr/ui';

/** Admin placeholder until the members and invite UI lands. */
export function AdminPage() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl text-ink">管理</h1>
        <p className="mt-1 text-sm text-muted">成员、邀请码和存储用量的管理入口。</p>
      </div>
      <EmptyState title="管理功能即将上线" description="成员邀请与存储管理将在后续任务中开放。" />
    </section>
  );
}
