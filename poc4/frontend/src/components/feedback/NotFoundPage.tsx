import { Link } from 'react-router';
import { SearchX } from 'lucide-react';
import { Brand } from '@/components/ui/Brand';

export function NotFoundPage() {
  return (
    <main className="lab-feedback-page">
      <Brand /><SearchX size={38} />
      <h1 className="text-lg font-medium">页面不存在</h1>
      <p className="text-sm text-muted-foreground">找不到此页面。</p>
      <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
        返回项目列表
      </Link>
    </main>
  );
}
