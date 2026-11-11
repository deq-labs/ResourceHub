import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_CONFIG } from '../tokens.js';
import { QueueService } from './queue.service.js';
import type { AppConfig } from '../config.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** SMTP mail. Locally this is Mailpit (http://localhost:8025); in Azure, Communication Services SMTP. */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queue: QueueService,
  ) {
    this.transport = nodemailer.createTransport(config.SMTP_URL);
  }

  async send(mail: OutgoingMail, tenantId: string | null = null): Promise<boolean> {
    try {
      if (this.config.MAIL_TRANSPORT === 'queue') {
        // Delivered by the worker with retries; the request never waits on SMTP.
        await this.queue.enqueueEmail({ tenantId, ...mail });
        return true;
      }
      await this.transport.sendMail({ from: this.config.MAIL_FROM, ...mail });
      return true;
    } catch (err) {
      this.logger.warn({ err, to: mail.to }, 'mail delivery failed');
      return false;
    }
  }
}
