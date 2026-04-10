'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MessageSquare, Brain, BookOpen } from 'lucide-react'
import { ChatPlayground } from './chat-playground'
import { MemoryManager } from './memory-manager'
import { KnowledgeBase } from './knowledge-base'

export function AITrainingCenter() {
  return (
    <Tabs defaultValue="playground" className="space-y-4">
      <TabsList>
        <TabsTrigger value="playground" className="gap-2">
          <MessageSquare className="h-4 w-4" />
          Playground
        </TabsTrigger>
        <TabsTrigger value="memory" className="gap-2">
          <Brain className="h-4 w-4" />
          Memory
        </TabsTrigger>
        <TabsTrigger value="knowledge" className="gap-2">
          <BookOpen className="h-4 w-4" />
          Knowledge Base
        </TabsTrigger>
      </TabsList>

      <TabsContent value="playground">
        <ChatPlayground />
      </TabsContent>

      <TabsContent value="memory">
        <MemoryManager />
      </TabsContent>

      <TabsContent value="knowledge">
        <KnowledgeBase />
      </TabsContent>
    </Tabs>
  )
}
