import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  SwaggerModule.setup('docs', app, doc);
  process.on('unhandledRejection', (err) => {
    console.log('oops', err);
  });
  await app.listen(3000);
}
bootstrap();
