import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'Digimium Conversations',
  description: 'Private customer support conversation dashboard for Digimium.',
  robots: { index: false, follow: false },
  openGraph: {
    title: 'Digimium Conversations',
    description: 'Customer support command center',
    images: [{ url: '/og.png', width: 600, height: 315 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Digimium Conversations',
    description: 'Customer support command center',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
