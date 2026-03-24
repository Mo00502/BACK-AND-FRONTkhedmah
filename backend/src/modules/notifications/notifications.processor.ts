import { Process, Processor, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { NotificationsService } from './notifications.service';

@Processor('notifications')
export class NotificationsProcessor {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private notifService: NotificationsService) {}

  @Process('sms')
  async handleSms(job: Job<{ phone: string; message: string }>) {
    const { phone, message } = job.data;
    this.logger.log(`Sending SMS to ${phone}`);
    await this.notifService.sendSms(phone, message);
  }

  @Process('email')
  async handleEmail(job: Job<{ to: string; subject: string; html: string }>) {
    const { to, subject, html } = job.data;
    this.logger.log(`Sending email to ${to}: ${subject}`);
    await this.notifService.sendEmail(to, subject, html);
  }

  @Process('push')
  async handlePush(
    job: Job<{ userId: string; title: string; body: string; data?: Record<string, string> }>,
  ) {
    const { userId, title, body, data } = job.data;
    this.logger.log(`Sending FCM push to user ${userId}: ${title}`);
    await this.notifService.sendPush(userId, title, body, data);
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    this.logger.error(
      `Notification job ${job.id} (${job.name}) failed after ${job.attemptsMade} attempt(s): ${err.message}`,
    );
  }
}
